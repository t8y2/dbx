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
var registerMetadataDriver sync.Once
var metadataState atomic.Pointer[metadataDriverState]

type fakeDriverState struct {
	mu             sync.Mutex
	nextConnID     int
	queryArgs      int
	queryCtx       context.Context
	queryConnID    int
	rowCount       int
	execStatements []string
	execConnIDs    []int
}

type fakeDriver struct{}

type fakeConn struct {
	id int
}

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
	mu                  sync.Mutex
	queries             []string
	databaseMode        *string
	backtickIdentifiers bool
	databaseErr         error
}

type modeDetectionDriver struct{}

type modeDetectionConn struct {
	state *modeDetectionDriverState
}

type metadataDriverState struct {
	mu      sync.Mutex
	queries []string
	query   func(string) (driver.Rows, error)
}

type metadataDriver struct{}

type metadataConn struct {
	state *metadataDriverState
}

type connectionAttemptState struct {
	mu         sync.Mutex
	attempts   []string
	dsns       []string
	deadlines  []time.Time
	pingErrors map[string]error
}

type connectionAttemptConnector struct {
	state   *connectionAttemptState
	sslMode string
}

type connectionAttemptDriver struct{}

type connectionAttemptConn struct {
	state   *connectionAttemptState
	sslMode string
}

type valueRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (fakeDriver) Open(string) (driver.Conn, error) {
	state := testDriverState.Load()
	state.mu.Lock()
	defer state.mu.Unlock()
	state.nextConnID++
	return fakeConn{id: state.nextConnID}, nil
}

func (fakeConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }

func (fakeConn) Close() error { return nil }

func (fakeConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

func (connection fakeConn) QueryContext(ctx context.Context, _ string, args []driver.NamedValue) (driver.Rows, error) {
	state := testDriverState.Load()
	state.mu.Lock()
	defer state.mu.Unlock()
	state.queryArgs = len(args)
	state.queryCtx = ctx
	state.queryConnID = connection.id
	return &fakeRows{count: state.rowCount}, nil
}

func (connection fakeConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	state := testDriverState.Load()
	state.mu.Lock()
	defer state.mu.Unlock()
	state.execStatements = append(state.execStatements, query)
	state.execConnIDs = append(state.execConnIDs, connection.id)
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
	if strings.Contains(query, "SELECT i.relname, sys_catalog.sys_get_indexdef(") || strings.Contains(query, "SELECT i.relname, pg_catalog.pg_get_indexdef(") {
		return &valueRows{
			columns: []string{"index_name", "index_definition", "index_comment"},
			rows: [][]driver.Value{
				{"orders_id_idx", `CREATE INDEX orders_id_idx ON public.orders USING btree (id)`, "lookup index"},
			},
		}, nil
	}
	if strings.Contains(query, "SELECT sys_catalog.sys_get_triggerdef(tg.oid, true)") || strings.Contains(query, "SELECT pg_catalog.pg_get_triggerdef(tg.oid, true)") {
		return &valueRows{
			columns: []string{"trigger_definition"},
			rows: [][]driver.Value{
				{`CREATE TRIGGER orders_audit BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION audit_orders()`},
			},
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
	case strings.Contains(query, "AS `dbx_identifier_probe`"):
		if !connection.state.backtickIdentifiers {
			return nil, &gokb.Error{Code: gokb.ErrorCode("42601"), Message: "syntax error at or near `"}
		}
		return &valueRows{columns: []string{"dbx_identifier_probe"}, rows: [][]driver.Value{{int64(1)}}}, nil
	default:
		return nil, errors.New("unexpected query: " + query)
	}
}

func (metadataDriver) Open(string) (driver.Conn, error) {
	return &metadataConn{state: metadataState.Load()}, nil
}

func (*metadataConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }

func (*metadataConn) Close() error { return nil }

func (*metadataConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

func (connection *metadataConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	connection.state.mu.Lock()
	connection.state.queries = append(connection.state.queries, query)
	connection.state.mu.Unlock()
	return connection.state.query(query)
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

func (state *connectionAttemptState) open(cp connectParams, sslMode string) (*sql.DB, error) {
	state.mu.Lock()
	state.attempts = append(state.attempts, sslMode)
	state.dsns = append(state.dsns, buildDSNWithSSLMode(cp, sslMode))
	state.mu.Unlock()
	return sql.OpenDB(connectionAttemptConnector{state: state, sslMode: sslMode}), nil
}

func (connector connectionAttemptConnector) Connect(context.Context) (driver.Conn, error) {
	return &connectionAttemptConn{state: connector.state, sslMode: connector.sslMode}, nil
}

func (connectionAttemptConnector) Driver() driver.Driver { return connectionAttemptDriver{} }

func (connectionAttemptDriver) Open(string) (driver.Conn, error) { return nil, driver.ErrSkip }

func (*connectionAttemptConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }

func (*connectionAttemptConn) Close() error { return nil }

func (*connectionAttemptConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

func (connection *connectionAttemptConn) Ping(ctx context.Context) error {
	connection.state.mu.Lock()
	if deadline, ok := ctx.Deadline(); ok {
		connection.state.deadlines = append(connection.state.deadlines, deadline)
	}
	err := connection.state.pingErrors[connection.sslMode]
	connection.state.mu.Unlock()
	return err
}

func (state *connectionAttemptState) snapshot() ([]string, []time.Time) {
	state.mu.Lock()
	defer state.mu.Unlock()
	return append([]string(nil), state.attempts...), append([]time.Time(nil), state.deadlines...)
}

func (state *connectionAttemptState) connectionStrings() []string {
	state.mu.Lock()
	defer state.mu.Unlock()
	return append([]string(nil), state.dsns...)
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

func openMetadataDB(t *testing.T, state *metadataDriverState) *sql.DB {
	t.Helper()
	registerMetadataDriver.Do(func() { sql.Register("kingbase-metadata-test", metadataDriver{}) })
	metadataState.Store(state)
	db, err := sql.Open("kingbase-metadata-test", "")
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

func TestBuildDSNNormalizesPreferWithoutPassingLiteralMode(t *testing.T) {
	cp := connectParams{
		Host:      "127.0.0.1",
		Port:      54321,
		Database:  "test",
		Username:  "system",
		Password:  "secret",
		URLParams: "SSLMODE=disable&sslmode=prefer&application_name=dbx",
	}
	if mode := effectiveSSLMode(cp); mode != "prefer" {
		t.Fatalf("unexpected effective SSL mode: %q", mode)
	}
	dsn := buildDSN(cp)
	if strings.Count(strings.ToLower(dsn), "sslmode=") != 1 {
		t.Fatalf("DSN must contain exactly one sslmode: %s", dsn)
	}
	if !strings.Contains(dsn, "sslmode=require") || strings.Contains(strings.ToLower(dsn), "sslmode=prefer") {
		t.Fatalf("prefer must be converted to the first require attempt: %s", dsn)
	}
	if !strings.Contains(dsn, "application_name='dbx'") {
		t.Fatalf("unrelated URL parameters must be preserved: %s", dsn)
	}
}

func TestBuildDSNOverridesPreferInNativeConnectionStrings(t *testing.T) {
	for _, test := range []struct {
		name               string
		connectionString   string
		preservedFragments []string
	}{
		{
			name:             "keyword DSN",
			connectionString: "host=db.example.com application_name='dbx app' sslmode = 'prefer' options='-c search_path=public tenant'",
			preservedFragments: []string{
				"host=db.example.com",
				"application_name='dbx app'",
				"options='-c search_path=public tenant'",
			},
		},
		{
			name:             "Kingbase URL",
			connectionString: "kingbase://system:secret@db.example.com/test?application_name=dbx&SSLMODE=prefer#section",
			preservedFragments: []string{
				"kingbase://system:secret@db.example.com/test?",
				"application_name=dbx",
				"#section",
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			cp := connectParams{ConnectionString: test.connectionString}
			if mode := effectiveSSLMode(cp); mode != "prefer" {
				t.Fatalf("unexpected effective SSL mode: %q", mode)
			}
			dsn := buildDSN(cp)
			if strings.Count(strings.ToLower(dsn), "sslmode=") != 1 {
				t.Fatalf("native DSN must contain exactly one sslmode: %s", dsn)
			}
			if strings.Contains(strings.ToLower(dsn), "prefer") || !strings.Contains(strings.ToLower(dsn), "sslmode=require") {
				t.Fatalf("native prefer must be replaced by require: %s", dsn)
			}
			for _, fragment := range test.preservedFragments {
				if !strings.Contains(dsn, fragment) {
					t.Fatalf("native DSN lost %q: %s", fragment, dsn)
				}
			}
		})
	}
}

func TestOpenAndPingDBNativeConnectionStringsWithoutSSLModeUsePreferFallback(t *testing.T) {
	for _, test := range []struct {
		name               string
		connectionString   string
		preservedFragments []string
	}{
		{
			name:             "keyword DSN",
			connectionString: "host=db.example.com application_name=dbx",
			preservedFragments: []string{
				"host=db.example.com",
				"application_name=dbx",
			},
		},
		{
			name:             "Kingbase URL",
			connectionString: "kingbase://system:secret@db.example.com/test?application_name=dbx",
			preservedFragments: []string{
				"kingbase://system:secret@db.example.com/test?",
				"application_name=dbx",
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			cp := connectParams{ConnectionString: test.connectionString}
			if mode := effectiveSSLMode(cp); mode != "prefer" {
				t.Fatalf("native connection string without sslmode must use prefer semantics: %q", mode)
			}

			state := &connectionAttemptState{pingErrors: map[string]error{"require": gokb.ErrSSLNotSupported}}
			db, err := openAndPingDB(cp, time.Second, state.open)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()

			attempts, _ := state.snapshot()
			if strings.Join(attempts, ",") != "require,disable" {
				t.Fatalf("unexpected implicit prefer attempts: %v", attempts)
			}
			dsns := state.connectionStrings()
			if len(dsns) != 2 {
				t.Fatalf("unexpected generated DSNs: %v", dsns)
			}
			for index, sslMode := range []string{"require", "disable"} {
				dsn := dsns[index]
				lowerDSN := strings.ToLower(dsn)
				if strings.Count(lowerDSN, "sslmode=") != 1 || !strings.Contains(lowerDSN, "sslmode="+sslMode) {
					t.Fatalf("attempt %s has unexpected sslmode: %s", sslMode, dsn)
				}
				if strings.Contains(lowerDSN, "sslmode=prefer") {
					t.Fatalf("literal prefer reached native driver DSN: %s", dsn)
				}
				for _, fragment := range test.preservedFragments {
					if !strings.Contains(dsn, fragment) {
						t.Fatalf("native DSN lost %q: %s", fragment, dsn)
					}
				}
			}
		})
	}
}

func TestOpenAndPingDBHonorsExplicitNativeConnectionStringMode(t *testing.T) {
	state := &connectionAttemptState{pingErrors: map[string]error{"require": gokb.ErrSSLNotSupported}}
	db, err := openAndPingDB(connectParams{ConnectionString: "host=db.example.com sslmode=require"}, time.Second, state.open)
	if db != nil {
		db.Close()
	}
	if !errors.Is(err, gokb.ErrSSLNotSupported) {
		t.Fatalf("unexpected error: %v", err)
	}
	attempts, _ := state.snapshot()
	if len(attempts) != 1 || attempts[0] != "require" {
		t.Fatalf("explicit native DSN mode must not downgrade: %v", attempts)
	}
}

func TestOpenAndPingDBPreferFallbackUsesOneTimeoutBudget(t *testing.T) {
	state := &connectionAttemptState{pingErrors: map[string]error{"require": gokb.ErrSSLNotSupported}}
	db, err := openAndPingDB(connectParams{}, time.Second, state.open)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	attempts, deadlines := state.snapshot()
	if strings.Join(attempts, ",") != "require,disable" {
		t.Fatalf("unexpected prefer attempts: %v", attempts)
	}
	if len(deadlines) != 2 || !deadlines[0].Equal(deadlines[1]) {
		t.Fatalf("prefer attempts must share one deadline: %v", deadlines)
	}
}

func TestOpenAndPingDBDoesNotDowngradeUnrelatedErrors(t *testing.T) {
	authErr := errors.New("authentication failed")
	state := &connectionAttemptState{pingErrors: map[string]error{"require": authErr}}
	db, err := openAndPingDB(connectParams{}, time.Second, state.open)
	if db != nil {
		db.Close()
	}
	if !errors.Is(err, authErr) {
		t.Fatalf("unexpected error: %v", err)
	}
	attempts, _ := state.snapshot()
	if strings.Join(attempts, ",") != "require" {
		t.Fatalf("unrelated errors must not downgrade: %v", attempts)
	}
}

func TestOpenAndPingDBExplicitModesNeverDowngrade(t *testing.T) {
	for _, sslMode := range []string{"disable", "require", "verify-ca", "verify-full"} {
		t.Run(sslMode, func(t *testing.T) {
			state := &connectionAttemptState{pingErrors: map[string]error{sslMode: gokb.ErrSSLNotSupported}}
			db, err := openAndPingDB(connectParams{URLParams: "sslmode=" + sslMode}, time.Second, state.open)
			if db != nil {
				db.Close()
			}
			if !errors.Is(err, gokb.ErrSSLNotSupported) {
				t.Fatalf("unexpected error: %v", err)
			}
			attempts, _ := state.snapshot()
			if len(attempts) != 1 || attempts[0] != sslMode {
				t.Fatalf("explicit mode must use one attempt: %v", attempts)
			}
		})
	}
}

func TestOpenAndPingDBSSLDefaultsToVerifyFull(t *testing.T) {
	state := &connectionAttemptState{pingErrors: map[string]error{}}
	db, err := openAndPingDB(connectParams{SSL: true}, time.Second, state.open)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	attempts, _ := state.snapshot()
	if len(attempts) != 1 || attempts[0] != "verify-full" {
		t.Fatalf("SSL=true must stay verify-full: %v", attempts)
	}
}

func TestConnectAndTestConnectionSharePreferFallback(t *testing.T) {
	for _, test := range []struct {
		name string
		run  func(*server, connectParams) error
	}{
		{name: "connect", run: func(server *server, cp connectParams) error { return server.connect(cp) }},
		{name: "test_connection", run: func(server *server, cp connectParams) error { return server.testConnection(cp) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := &connectionAttemptState{pingErrors: map[string]error{"require": gokb.ErrSSLNotSupported}}
			server := newServer()
			server.openDatabase = state.open
			cp := connectParams{URLParams: "sslmode=prefer", MySQLCompatMode: true}
			if err := test.run(server, cp); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = server.disconnect() })
			attempts, _ := state.snapshot()
			if strings.Join(attempts, ",") != "require,disable" {
				t.Fatalf("unexpected attempts: %v", attempts)
			}
		})
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

func TestKingbaseCatalogFunctionsFollowMetadataMode(t *testing.T) {
	registerExpressionFallbackDriver.Do(func() { sql.Register("kingbase-expression-fallback-test", fallbackDriver{}) })
	tests := []struct {
		name            string
		postgresCatalog bool
		expectedIndex   string
		expectedTrigger string
	}{
		{name: "sys catalog", expectedIndex: "sys_catalog.sys_get_indexdef", expectedTrigger: "sys_catalog.sys_get_triggerdef"},
		{name: "postgres catalog", postgresCatalog: true, expectedIndex: "pg_catalog.pg_get_indexdef", expectedTrigger: "pg_catalog.pg_get_triggerdef"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
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
			server.mode.postgresCatalog = test.postgresCatalog

			if _, err := server.listIndexDefinitions("public", "orders"); err != nil {
				t.Fatal(err)
			}
			if _, err := server.listTriggerDefinitions("public", "orders"); err != nil {
				t.Fatal(err)
			}

			state.mu.Lock()
			queries := append([]string(nil), state.queries...)
			state.mu.Unlock()
			if len(queries) != 2 || !strings.Contains(queries[0], test.expectedIndex+"(") || !strings.Contains(queries[1], test.expectedTrigger+"(") {
				t.Fatalf("catalog functions do not match metadata mode: %v", queries)
			}
		})
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

func TestListSchemasQueryIncludesSystemSchemasWhenEnabled(t *testing.T) {
	for _, mode := range []kingbaseMode{{}, {postgresCatalog: true}, {mysqlCompat: true}} {
		query := kingbaseListSchemasSQL(mode, true)
		if strings.Contains(query, "NOT LIKE") || strings.Contains(query, "<>") {
			t.Fatalf("show-system query must not filter schemas: %s", query)
		}
	}
}

func TestListSchemasQueryKeepsDefaultTemporarySchemaFilters(t *testing.T) {
	for _, mode := range []kingbaseMode{{}, {postgresCatalog: true}} {
		query := kingbaseListSchemasSQL(mode, false)
		if !strings.Contains(query, "temp_%") {
			t.Fatalf("default query must keep temporary schema filters: %s", query)
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

func TestListDatabasesFallsBackToPostgresCatalog(t *testing.T) {
	state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
		switch {
		case strings.Contains(query, "sys_catalog.sys_database"):
			return nil, errors.New("sys catalog unavailable")
		case strings.Contains(query, "pg_catalog.pg_database"):
			return &valueRows{columns: []string{"datname"}, rows: [][]driver.Value{{"app"}, {"test"}}}, nil
		default:
			return nil, errors.New("unexpected query: " + query)
		}
	}}
	server := newServer()
	server.db = openMetadataDB(t, state)
	server.params.Database = "configured"

	databases, err := server.listDatabases()
	if err != nil {
		t.Fatal(err)
	}
	if len(databases) != 2 || databases[0].Name != "app" || databases[1].Name != "test" {
		t.Fatalf("unexpected databases: %#v", databases)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.queries) != 2 || !strings.Contains(state.queries[0], "sys_catalog.sys_database") || !strings.Contains(state.queries[1], "pg_catalog.pg_database") {
		t.Fatalf("catalog fallback order changed: %v", state.queries)
	}
}

func TestListTablesPreservesKingbaseObjectTypesAndComments(t *testing.T) {
	state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
		if !strings.Contains(query, "FROM sys_catalog.sys_class c") || !strings.Contains(query, "c.relkind IN ('r','p','v','m','f')") {
			return nil, errors.New("unexpected query: " + query)
		}
		return &valueRows{
			columns: []string{"relname", "relkind", "comment"},
			rows: [][]driver.Value{
				{"orders", "TABLE", "orders table"},
				{"sales_view", "VIEW", nil},
				{"sales_cache", "MATERIALIZED_VIEW", "cached sales"},
			},
		}, nil
	}}
	server := newServer()
	server.db = openMetadataDB(t, state)

	tables, err := server.listTables("public", metadataListConstraints{Filter: "sales", ObjectTypes: []string{"VIEW", "MATERIALIZED_VIEW"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) != 2 || tables[0].TableType != "VIEW" || tables[1].TableType != "MATERIALIZED_VIEW" {
		t.Fatalf("unexpected tables: %#v", tables)
	}
	if tables[1].Comment == nil || *tables[1].Comment != "cached sales" {
		t.Fatalf("materialized view comment was lost: %#v", tables[1])
	}
}

func TestListTriggersUsesCompatibilityCatalogAndDecodesTiming(t *testing.T) {
	state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
		if !strings.Contains(query, "FROM pg_catalog.pg_trigger") || !strings.Contains(query, "NOT tg.tgisinternal") {
			return nil, errors.New("unexpected query: " + query)
		}
		return &valueRows{
			columns: []string{"tgname", "event", "tgtype"},
			rows:    [][]driver.Value{{"orders_before", "INSERT,UPDATE", int64(2)}, {"orders_instead", "DELETE", int64(64)}},
		}, nil
	}}
	server := newServer()
	server.db = openMetadataDB(t, state)
	server.mode.postgresCatalog = true

	triggers, err := server.listTriggers("public", "orders")
	if err != nil {
		t.Fatal(err)
	}
	if len(triggers) != 2 || triggers[0].Timing != "BEFORE" || triggers[1].Timing != "INSTEAD OF" {
		t.Fatalf("unexpected triggers: %#v", triggers)
	}
}

func TestRoutineSourceUsesKingbaseCatalogFunction(t *testing.T) {
	state := &metadataDriverState{query: func(query string) (driver.Rows, error) {
		if !strings.Contains(query, "SELECT sys_get_functiondef(p.oid)") || !strings.Contains(query, "FROM sys_catalog.sys_proc") {
			return nil, errors.New("unexpected query: " + query)
		}
		return &valueRows{columns: []string{"source"}, rows: [][]driver.Value{{"CREATE FUNCTION public.format_name() RETURNS text AS $$ SELECT 'x'; $$"}}}, nil
	}}
	server := newServer()
	server.db = openMetadataDB(t, state)

	source, err := server.getObjectSource("public", "format_name", "FUNCTION")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(source["source"].(string), "CREATE FUNCTION public.format_name()") {
		t.Fatalf("unexpected routine source: %#v", source)
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

func TestTableDDLIncludesIdentityIndexesTriggersAndComments(t *testing.T) {
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
	for _, expected := range []string{
		`COMMENT ON TABLE "public"."orders" IS 'orders table';`,
		`CREATE INDEX orders_id_idx ON public.orders USING btree (id);`,
		`COMMENT ON INDEX "public"."orders_id_idx" IS 'lookup index';`,
		`CREATE TRIGGER orders_audit BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION audit_orders();`,
	} {
		if !strings.Contains(ddl, expected) {
			t.Fatalf("table DDL missing %q:\n%s", expected, ddl)
		}
	}
}

func TestRenderTableDDLIncludesEscapedComments(t *testing.T) {
	primaryComment := "主键'编号"
	emptyComment := "  "
	tableComment := "订单'表"
	ddl := renderTableDDL(
		`app"schema`,
		`order"items`,
		[]columnInfo{
			{Name: `id"value`, DataType: "integer", IsNullable: false, IsPrimaryKey: true, Comment: &primaryComment},
			{Name: "note", DataType: "text", IsNullable: true, Comment: &emptyComment},
		},
		&tableComment,
	)

	expected := []string{
		`CREATE TABLE "app""schema"."order""items"`,
		`COMMENT ON TABLE "app""schema"."order""items" IS '订单''表';`,
		`COMMENT ON COLUMN "app""schema"."order""items"."id""value" IS '主键''编号';`,
	}
	for _, fragment := range expected {
		if !strings.Contains(ddl, fragment) {
			t.Fatalf("table DDL missing %q:\n%s", fragment, ddl)
		}
	}
	if strings.Contains(ddl, `COMMENT ON COLUMN "app""schema"."order""items"."note"`) {
		t.Fatalf("blank column comment must be omitted:\n%s", ddl)
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

func TestAppendDDLStatementEnsuresSingleTerminator(t *testing.T) {
	got := appendDDLStatement("CREATE TABLE \"public\".\"orders\" (\n  \"id\" integer\n)\n", "CREATE INDEX orders_id_idx ON public.orders (id)")
	want := "CREATE TABLE \"public\".\"orders\" (\n  \"id\" integer\n);\n\nCREATE INDEX orders_id_idx ON public.orders (id);"
	if got != want {
		t.Fatalf("unexpected appended DDL:\ngot:  %q\nwant: %q", got, want)
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

func TestDetectMySQLCompatModePrefersDatabaseModeOverSyntaxProbe(t *testing.T) {
	oracle := "oracle"
	state := &modeDetectionDriverState{
		databaseMode:        &oracle,
		backtickIdentifiers: true,
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

func TestDetectMySQLCompatModeAcceptsExplicitMySQLMode(t *testing.T) {
	mysql := "mysql"
	state := &modeDetectionDriverState{databaseMode: &mysql}
	db := openModeDetectionDB(t, state)

	if !detectMySQLCompatMode(db) {
		t.Fatal("database_mode=mysql should use MySQL compatibility")
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.queries) != 1 || !strings.Contains(state.queries[0], "database_mode") {
		t.Fatalf("explicit MySQL mode should not need the syntax probe: %v", state.queries)
	}
}

func TestDetectKingbaseModeReportsDatabaseMode(t *testing.T) {
	for _, databaseMode := range []string{"oracle", "postgresql"} {
		t.Run(databaseMode, func(t *testing.T) {
			db := openModeDetectionDB(t, &modeDetectionDriverState{databaseMode: &databaseMode})

			mode := detectKingbaseMode(db, false)

			if mode.compatibilityMode != databaseMode {
				t.Fatalf("unexpected compatibility mode: %q", mode.compatibilityMode)
			}
		})
	}
}

func TestConnectionInfoReportsCompatibilityIdentifierQuote(t *testing.T) {
	for _, testCase := range []struct {
		name              string
		compatibilityMode string
		mysqlCompat       bool
		expectedQuote     string
	}{
		{name: "postgres compatible", compatibilityMode: "postgresql", expectedQuote: `"`},
		{name: "oracle compatible", compatibilityMode: "oracle", expectedQuote: `"`},
		{name: "mysql compatible", compatibilityMode: "mysql", mysqlCompat: true, expectedQuote: "`"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			db := openModeDetectionDB(t, &modeDetectionDriverState{})
			server := newServer()
			server.db = db
			server.mode.compatibilityMode = testCase.compatibilityMode
			server.mode.mysqlCompat = testCase.mysqlCompat

			info, err := server.connectionInfo()
			if err != nil {
				t.Fatal(err)
			}
			if info["compatibilityMode"] != testCase.compatibilityMode {
				t.Fatalf("unexpected compatibility mode: %#v", info["compatibilityMode"])
			}
			if info["identifierQuote"] != testCase.expectedQuote {
				t.Fatalf("unexpected identifier quote: %#v", info["identifierQuote"])
			}
		})
	}
}

func TestDetectMySQLCompatModeProbesBacktickSyntaxWhenDatabaseModeMissing(t *testing.T) {
	state := &modeDetectionDriverState{backtickIdentifiers: true}
	db := openModeDetectionDB(t, state)

	if !detectMySQLCompatMode(db) {
		t.Fatal("legacy server accepting backtick identifiers should use MySQL compatibility")
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.queries) != 2 || !strings.Contains(state.queries[1], "dbx_identifier_probe") {
		t.Fatalf("expected database_mode probe followed by backtick syntax probe, got: %v", state.queries)
	}
}

func TestDetectMySQLCompatModeRejectsSQLModeWithoutBacktickSyntax(t *testing.T) {
	state := &modeDetectionDriverState{}
	db := openModeDetectionDB(t, state)

	if detectMySQLCompatMode(db) {
		t.Fatal("legacy server rejecting backtick identifiers must not use MySQL compatibility")
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

func TestExecuteQueryReappliesSchemaForRepeatedRequests(t *testing.T) {
	db, state := openFakeDB(t, 1)
	server := newServer()
	server.db = db

	for range 2 {
		if _, err := server.executeQuery(queryOptions{SQL: "SELECT 1", Schema: "sdy_smartsite", MaxRows: 10}); err != nil {
			t.Fatal(err)
		}
	}

	expected := []string{`SET search_path TO "sdy_smartsite"`, `SET search_path TO "sdy_smartsite"`}
	if len(state.execStatements) != len(expected) {
		t.Fatalf("expected repeated schema setup, got %v", state.execStatements)
	}
	for index, statement := range expected {
		if state.execStatements[index] != statement {
			t.Fatalf("unexpected schema statement at %d: %s", index, state.execStatements[index])
		}
	}
}

func TestExecuteQueryAppliesSchemaOnSamePoolConnection(t *testing.T) {
	db, state := openFakeDB(t, 1)
	db.SetMaxOpenConns(4)
	server := newServer()
	server.db = db

	if _, err := server.executeQuery(queryOptions{SQL: "SELECT 1", Schema: "sdy_smartsite", MaxRows: 10}); err != nil {
		t.Fatal(err)
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.execStatements) != 1 || state.execStatements[0] != `SET search_path TO "sdy_smartsite"` {
		t.Fatalf("unexpected schema setup: %v", state.execStatements)
	}
	if len(state.execConnIDs) != 1 || state.execConnIDs[0] != state.queryConnID {
		t.Fatalf("schema setup and query used different connections: exec=%v query=%d", state.execConnIDs, state.queryConnID)
	}
}

func TestExecuteStatementAppliesSchemaOnSamePoolConnection(t *testing.T) {
	db, state := openFakeDB(t, 0)
	db.SetMaxOpenConns(4)
	server := newServer()
	server.db = db

	if _, err := server.executeQuery(queryOptions{SQL: "UPDATE orders SET status = 1", Schema: "sdy_smartsite"}); err != nil {
		t.Fatal(err)
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	expected := []string{`SET search_path TO "sdy_smartsite"`, "UPDATE orders SET status = 1"}
	if strings.Join(state.execStatements, "\n") != strings.Join(expected, "\n") {
		t.Fatalf("unexpected statements: %v", state.execStatements)
	}
	if len(state.execConnIDs) != 2 || state.execConnIDs[0] != state.execConnIDs[1] {
		t.Fatalf("schema setup and statement used different connections: %v", state.execConnIDs)
	}
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
