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

	pq "gitcode.com/opengauss/openGauss-connector-go-pq"
)

func TestVastbaseHandshakeAdvertisesMultiSessionSQLAgent(t *testing.T) {
	runtime := &runtimeServer{sessions: map[string]*agentSession{}}
	result, shutdown, err := runtime.dispatch("handshake", nil)
	if err != nil {
		t.Fatalf("handshake failed: %v", err)
	}
	if shutdown {
		t.Fatal("handshake must not request shutdown")
	}
	payload, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal handshake: %v", err)
	}
	text := string(payload)
	for _, expected := range []string{`"protocolVersion":2`, `"multi_session"`, `"metadata"`, `"paged_query"`, `"structured_error_v1"`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("handshake missing %s: %s", expected, text)
		}
	}
}

func TestQueryOptionsFromParams(t *testing.T) {
	params := map[string]json.RawMessage{
		"sql":         json.RawMessage(`"SELECT 1"`),
		"database":    json.RawMessage(`"dbx"`),
		"schema":      json.RawMessage(`"public"`),
		"maxRows":     json.RawMessage(`1000`),
		"fetchSize":   json.RawMessage(`250`),
		"timeoutSecs": json.RawMessage(`15`),
	}
	expected := queryOptions{SQL: "SELECT 1", Database: "dbx", Schema: "public", MaxRows: 1000, FetchSize: 250, TimeoutSecs: 15}
	if actual := queryOptionsFromParams(params); actual != expected {
		t.Fatalf("queryOptionsFromParams() = %+v, want %+v", actual, expected)
	}
}

func TestVastbaseBuildDSNUsesNativeDefaultsForJDBCURL(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:             "vastbase.example.com",
		Database:         "postgres",
		Username:         "vbadmin",
		Password:         "secret",
		ConnectionString: "jdbc:vastbase://vastbase.example.com:5432/postgres",
		URLParams:        "application_name=dbx",
	})
	for _, expected := range []string{
		"host='vastbase.example.com'",
		"port=5432",
		"user='vbadmin'",
		"password='secret'",
		"dbname='postgres'",
		"sslmode=prefer",
		"application_name='dbx'",
	} {
		if !strings.Contains(dsn, expected) {
			t.Fatalf("DSN missing %s: %s", expected, dsn)
		}
	}
}

func TestVastbaseBuildDSNPreservesNativeConnectionString(t *testing.T) {
	dsn := buildDSNWithSSLMode(connectParams{
		ConnectionString: "postgresql://vbadmin:secret@vastbase.example.com:5432/postgres?application_name=dbx&sslmode=disable",
	}, "verify-full")
	if !strings.Contains(dsn, "application_name=dbx") || !strings.Contains(dsn, "sslmode=verify-full") {
		t.Fatalf("unexpected rewritten native DSN: %s", dsn)
	}
	if strings.Contains(dsn, "sslmode=disable") {
		t.Fatalf("old sslmode was not replaced: %s", dsn)
	}
}

func TestVastbaseBuildDSNTranslatesJDBCParameters(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:      "vastbase.example.com",
		Database:  "postgres",
		Username:  "vbadmin",
		Password:  "secret",
		URLParams: "targetServerType=master&connectTimeout=7&currentSchema=app&applicationName=dbx&sslmode=enable&autosave=always&enable_ce=1&db_compatibility=PG",
	})
	for _, expected := range []string{
		"target_session_attrs='primary'",
		"connect_timeout='7'",
		"search_path='app'",
		"application_name='dbx'",
		"sslmode=require",
	} {
		if !strings.Contains(dsn, expected) {
			t.Fatalf("translated DSN missing %s: %s", expected, dsn)
		}
	}
	for _, rejected := range []string{"targetServerType", "currentSchema", "applicationName", "autosave", "enable_ce", "db_compatibility"} {
		if strings.Contains(dsn, rejected) {
			t.Fatalf("JDBC-only parameter leaked into DSN: %s", dsn)
		}
	}
}

func TestVastbaseDriverRegistration(t *testing.T) {
	if !containsString(sql.Drivers(), agentSQLDriverName) {
		t.Fatalf("%s driver is not registered: %v", agentSQLDriverName, sql.Drivers())
	}
}

func TestVastbaseObjectSourceNormalization(t *testing.T) {
	tests := map[string]string{
		`(1,"CREATE FUNCTION f() RETURNS int AS ''SELECT 1'';")`: `CREATE FUNCTION f() RETURNS int AS ''SELECT 1'';`,
		`("CREATE VIEW v AS SELECT 1")`:                          `CREATE VIEW v AS SELECT 1`,
		`CREATE VIEW v AS SELECT 1`:                              `CREATE VIEW v AS SELECT 1`,
	}
	for input, expected := range tests {
		if actual := normalizeAgentObjectSource(input); actual != expected {
			t.Fatalf("normalizeAgentObjectSource(%q) = %q, want %q", input, actual, expected)
		}
	}
}

func TestVastbaseDataTypesIncludeVectorFamilies(t *testing.T) {
	types := agentDataTypes()
	for _, expected := range []string{"floatvector", "halfvector", "int8vector", "sparsevector"} {
		if !containsString(types, expected) {
			t.Fatalf("missing Vastbase data type %s: %v", expected, types)
		}
	}
}

func TestVastbaseMetadataErrorClassificationUsesOpenGaussCodes(t *testing.T) {
	undefinedColumn := &pq.Error{Code: pq.ErrorCode("42703"), Message: "column a.attidentity does not exist"}
	if !isUndefinedColumn(undefinedColumn, "attidentity") {
		t.Fatal("undefined Vastbase column was not recognized")
	}
	undefinedFunction := &pq.Error{Code: pq.ErrorCode("42883"), Message: "function pg_get_expr does not exist"}
	if !isUndefinedFunction(undefinedFunction, "pg_get_expr") {
		t.Fatal("undefined Vastbase function was not recognized")
	}
}
func TestVastbaseCompatibilityNormalization(t *testing.T) {
	for _, test := range []struct {
		raw       string
		mode      string
		mysql     bool
		sqlServer bool
		disable   bool
	}{
		{raw: "A", mode: "oracle"},
		{raw: "O", mode: "oracle", disable: true},
		{raw: "ORA", mode: "oracle", disable: true},
		{raw: "ORACLE", mode: "oracle", disable: true},
		{raw: "B", mode: "mysql", mysql: true},
		{raw: "M", mode: "mysql", mysql: true},
		{raw: "MYSQL", mode: "mysql", mysql: true},
		{raw: "PG", mode: "postgres"},
		{raw: "POSTGRESQL", mode: "postgres"},
		{raw: "MSSQL", mode: "sqlserver", sqlServer: true},
		{raw: "SQL_SERVER", mode: "sqlserver", sqlServer: true},
	} {
		t.Run(test.raw, func(t *testing.T) {
			actual := normalizeVastbaseCompatibility(test.raw)
			if actual.mode != test.mode || actual.mysqlCompat != test.mysql || actual.sqlServer != test.sqlServer || actual.supportsDisableConstraint != test.disable {
				t.Fatalf("normalizeVastbaseCompatibility(%q) = %+v", test.raw, actual)
			}
		})
	}
}

func TestVastbaseModeUsesPostgresCatalog(t *testing.T) {
	mode := detectAgentMode(nil, false)
	if mode.compatibilityMode != "postgres" || !mode.postgresCatalog || mode.mysqlCompat {
		t.Fatalf("unexpected default Vastbase mode: %+v", mode)
	}
	mysqlMode := detectAgentMode(nil, true)
	if mysqlMode.compatibilityMode != "mysql" || !mysqlMode.postgresCatalog || !mysqlMode.mysqlCompat {
		t.Fatalf("unexpected MySQL-compatible Vastbase mode: %+v", mysqlMode)
	}
	for _, compatibility := range []string{"M", "B", "MYSQL"} {
		resolved := vastbaseMode{compatibilityMode: strings.ToLower(compatibility), postgresCatalog: true}
		resolved.mysqlCompat = resolved.compatibilityMode == "m" || resolved.compatibilityMode == "b" || resolved.compatibilityMode == "mysql"
		if !resolved.mysqlCompat {
			t.Fatalf("compatibility %q must use MySQL identifier rules: %+v", compatibility, resolved)
		}
	}
}

func TestVastbaseDisableConstraintMode(t *testing.T) {
	for _, mode := range []struct {
		raw  string
		want bool
	}{
		{raw: "A", want: false},
		{raw: "O", want: true},
		{raw: "ORA", want: true},
		{raw: "oracle", want: true},
		{raw: "B", want: false},
		{raw: "M", want: false},
		{raw: "mysql", want: false},
		{raw: "C", want: false},
	} {
		compatibility := normalizeVastbaseCompatibility(mode.raw)
		if actual := vastbaseSupportsDisableConstraint(vastbaseMode{supportsDisableConstraint: compatibility.supportsDisableConstraint}); actual != mode.want {
			t.Fatalf("vastbaseSupportsDisableConstraint(%q) = %v, want %v", mode.raw, actual, mode.want)
		}
	}
}

func TestSchemaConnectionRecoversAfterCanceledDriverConnection(t *testing.T) {
	registerVastbaseSchemaRetryDriver.Do(func() {
		sql.Register("vastbase-schema-retry-test", &schemaRetryDriver{})
	})
	schemaRetryOpens.Store(0)
	db, err := sql.Open("vastbase-schema-retry-test", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	server := newServer()
	server.db = db
	conn, err := server.schemaConn(context.Background(), "public")
	if err != nil {
		t.Fatalf("schema connection did not recover: %v", err)
	}
	defer conn.Close()
	if opens := schemaRetryOpens.Load(); opens != 2 {
		t.Fatalf("expected one replacement connection, opened %d", opens)
	}
}

func TestValidateConnectionRecoversAfterCanceledDriverConnection(t *testing.T) {
	registerVastbasePingRetryDriver.Do(func() {
		sql.Register("vastbase-ping-retry-test", &pingRetryDriver{})
	})
	pingRetryOpens.Store(0)
	db, err := sql.Open("vastbase-ping-retry-test", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	server := newServer()
	server.db = db
	if err := server.validateConnection(); err != nil {
		t.Fatalf("connection validation did not recover: %v", err)
	}
	if opens := pingRetryOpens.Load(); opens != 2 {
		t.Fatalf("expected one replacement connection, opened %d", opens)
	}
}

func TestPagedQueryTimeoutDoesNotExpireWhilePageIsIdle(t *testing.T) {
	registerVastbasePaginationDriver.Do(func() {
		sql.Register("vastbase-pagination-timeout-test", &paginationTimeoutDriver{})
	})
	db, err := sql.Open("vastbase-pagination-timeout-test", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	server := newServer()
	server.db = db
	first, err := server.executeQueryPage(queryOptions{SQL: "SELECT id FROM rows", MaxRows: 3, TimeoutSecs: 1}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.SessionID == nil || !first.HasMore || len(first.Rows) != 1 {
		t.Fatalf("unexpected first page: %#v", first)
	}

	time.Sleep(1100 * time.Millisecond)
	second, err := server.fetchQueryPage(*first.SessionID, 1)
	if err != nil {
		t.Fatalf("idle time must not consume the next page timeout: %v", err)
	}
	if !second.HasMore || len(second.Rows) != 1 || second.Rows[0][0] != int64(2) {
		t.Fatalf("unexpected second page: %#v", second)
	}
	server.closeAllQuerySessions()
}

func TestPagedQueryTimeoutStillAppliesToEachFetch(t *testing.T) {
	registerVastbasePaginationDriver.Do(func() {
		sql.Register("vastbase-pagination-timeout-test", &paginationTimeoutDriver{})
	})
	db, err := sql.Open("vastbase-pagination-timeout-test", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	server := newServer()
	server.db = db
	first, err := server.executeQueryPage(queryOptions{SQL: "SELECT id FROM slow_rows", MaxRows: 3, TimeoutSecs: 1}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.SessionID == nil {
		t.Fatalf("expected a paged query session: %#v", first)
	}

	started := time.Now()
	_, err = server.fetchQueryPage(*first.SessionID, 1)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected fetch timeout, got %v", err)
	}
	if elapsed := time.Since(started); elapsed < time.Second || elapsed > 3*time.Second {
		t.Fatalf("fetch timeout fired outside the expected window: %s", elapsed)
	}
	if len(server.sessions) != 0 {
		t.Fatalf("timed-out query session was retained: %#v", server.sessions)
	}
}

func TestDisconnectResetsInformationSchemaCapabilityCache(t *testing.T) {
	server := newServer()
	server.infoColumnTypeUnsupported = true
	server.infoUdtNameUnsupported = true

	if err := server.disconnect(); err != nil {
		t.Fatal(err)
	}
	if server.infoColumnTypeUnsupported || server.infoUdtNameUnsupported {
		t.Fatal("disconnect must reset cached information_schema capabilities")
	}
}

func TestDisconnectResetsConstraintCapabilityCache(t *testing.T) {
	server := newServer()
	server.constraintDefinitionUnsupported = true
	server.constraintValidatedUnsupported = true
	if err := server.disconnect(); err != nil {
		t.Fatal(err)
	}
	if server.constraintDefinitionUnsupported || server.constraintValidatedUnsupported {
		t.Fatal("disconnect must reset cached constraint capabilities")
	}
}

var (
	registerVastbaseSchemaRetryDriver sync.Once
	registerVastbasePingRetryDriver   sync.Once
	registerVastbasePaginationDriver  sync.Once
	schemaRetryOpens                  atomic.Int32
	pingRetryOpens                    atomic.Int32
)

type paginationTimeoutDriver struct{}

func (*paginationTimeoutDriver) Open(string) (driver.Conn, error) {
	return &paginationTimeoutConn{}, nil
}

type paginationTimeoutConn struct{}

func (*paginationTimeoutConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (*paginationTimeoutConn) Close() error                        { return nil }
func (*paginationTimeoutConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }

func (*paginationTimeoutConn) QueryContext(ctx context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	rows := &paginationTimeoutRows{ctx: ctx, values: []int64{1, 2, 3}, blockAt: -1}
	if strings.Contains(query, "slow_rows") {
		rows.blockAt = 2
	}
	return rows, nil
}

type paginationTimeoutRows struct {
	ctx     context.Context
	values  []int64
	index   int
	blockAt int
}

func (*paginationTimeoutRows) Columns() []string { return []string{"id"} }
func (*paginationTimeoutRows) Close() error      { return nil }

func (rows *paginationTimeoutRows) Next(dest []driver.Value) error {
	if rows.index == rows.blockAt {
		<-rows.ctx.Done()
		return rows.ctx.Err()
	}
	select {
	case <-rows.ctx.Done():
		return rows.ctx.Err()
	default:
	}
	if rows.index >= len(rows.values) {
		return io.EOF
	}
	dest[0] = rows.values[rows.index]
	rows.index++
	return nil
}

type schemaRetryDriver struct{}

func (*schemaRetryDriver) Open(string) (driver.Conn, error) {
	return &schemaRetryConn{bad: schemaRetryOpens.Add(1) == 1}, nil
}

type schemaRetryConn struct {
	bad bool
}

func (*schemaRetryConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (*schemaRetryConn) Close() error                        { return nil }
func (*schemaRetryConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }

func (conn *schemaRetryConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	if conn.bad {
		return nil, driver.ErrBadConn
	}
	return driver.RowsAffected(0), nil
}

type pingRetryDriver struct{}

func (*pingRetryDriver) Open(string) (driver.Conn, error) {
	return &pingRetryConn{bad: pingRetryOpens.Add(1) == 1}, nil
}

type pingRetryConn struct {
	bad bool
}

func (*pingRetryConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (*pingRetryConn) Close() error                        { return nil }
func (*pingRetryConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }

func (conn *pingRetryConn) Ping(context.Context) error {
	if conn.bad {
		return driver.ErrBadConn
	}
	return nil
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
