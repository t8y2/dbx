package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

func TestSchemaCacheTracksPhysicalConnectionAndSchema(t *testing.T) {
	state := &schemaCacheTestState{invalid: map[int]bool{}}
	db := openSchemaCacheTestDB(t, state)
	server := newServer()
	server.db = db

	conn := mustSchemaConn(t, server, "")
	_ = conn.Close()
	if statements := state.executedStatements(); len(statements) != 0 {
		t.Fatalf("fresh connection should preserve its initial schema: %v", statements)
	}

	conn = mustSchemaConn(t, server, "public")
	_ = conn.Close()
	conn = mustSchemaConn(t, server, "public")
	_ = conn.Close()
	conn = mustSchemaConn(t, server, "analytics")
	_ = conn.Close()
	conn = mustSchemaConn(t, server, "")
	_ = conn.Close()

	expected := []string{`SET search_path TO "public"`, `SET search_path TO "analytics"`, "RESET search_path"}
	if statements := state.executedStatements(); fmt.Sprint(statements) != fmt.Sprint(expected) {
		t.Fatalf("unexpected schema statements: got %v want %v", statements, expected)
	}
}

func TestSchemaCacheReappliesSchemaAfterPhysicalConnectionReplacement(t *testing.T) {
	state := &schemaCacheTestState{invalid: map[int]bool{}}
	db := openSchemaCacheTestDB(t, state)
	server := newServer()
	server.db = db

	conn := mustSchemaConn(t, server, "public")
	state.invalidateLatest()
	_ = conn.Close()
	conn = mustSchemaConn(t, server, "public")
	_ = conn.Close()

	if opens := state.openCount(); opens != 2 {
		t.Fatalf("expected replacement physical connection, opened %d", opens)
	}
	expected := []string{`SET search_path TO "public"`, `SET search_path TO "public"`}
	if statements := state.executedStatements(); fmt.Sprint(statements) != fmt.Sprint(expected) {
		t.Fatalf("schema was not reapplied after replacement: got %v want %v", statements, expected)
	}
}

func TestSessionStateSQLInvalidatesSchemaCache(t *testing.T) {
	mutating := []string{
		"SET search_path TO app",
		"SELECT 1; \n SET ROLE analyst",
		"RESET ALL",
		"DISCARD ALL",
		"ALTER SESSION SET CURRENT_SCHEMA = app",
		"SELECT set_config('search_path', 'app', false)",
		"SELECT pg_catalog.set_config ('role', 'analyst', false)",
		"-- switch schema\nSET search_path TO app",
		"SELECT 1; /* switch role */ RESET ROLE",
	}
	for _, statement := range mutating {
		server := newServer()
		server.currentSchema = "public"
		server.schemaInitialized = true
		server.schemaConnectionID = 1
		server.invalidateSchemaAfterSQL(statement)
		if server.schemaInitialized {
			t.Fatalf("schema cache was not invalidated for %q", statement)
		}
	}

	for _, statement := range []string{
		"SELECT 1",
		"SELECT 'SET search_path TO app'",
		"SELECT 'set_config(''search_path'', ''app'', false)'",
		"SELECT $$RESET ALL$$",
		"ALTER TABLE t ADD COLUMN value integer",
	} {
		server := newServer()
		server.currentSchema = "public"
		server.schemaInitialized = true
		server.schemaConnectionID = 1
		server.invalidateSchemaAfterSQL(statement)
		if !server.schemaInitialized {
			t.Fatalf("schema cache was unnecessarily invalidated for %q", statement)
		}
	}
}

func TestSQLRequiresSessionAffinity(t *testing.T) {
	for _, statement := range []string{
		"CREATE TEMP TABLE scratch(id integer)",
		"CREATE TEMPORARY TABLE scratch(id integer)",
		"SELECT 1 INTO TEMP scratch",
		"BEGIN",
		"START TRANSACTION",
		"SET ROLE analyst",
		"RESET ROLE",
		"SELECT pg_advisory_lock(42)",
		"SELECT pg_try_advisory_xact_lock(42)",
		"SELECT pg_advisory_unlock_all()",
		"SELECT set_config('search_path', 'app', false)",
	} {
		if !sqlRequiresSessionAffinity(statement) {
			t.Fatalf("session affinity was not detected for %q", statement)
		}
	}

	for _, statement := range []string{
		"SELECT 1",
		"CREATE TABLE durable(id integer)",
		"SELECT 'BEGIN; SET ROLE analyst'",
		"SELECT $$CREATE TEMP TABLE scratch(id integer)$$",
		"SELECT \"pg_advisory_lock\" FROM functions",
		"-- SET ROLE analyst\nSELECT 1",
		"/* CREATE TEMP TABLE scratch(id integer) */ SELECT 1",
	} {
		if sqlRequiresSessionAffinity(statement) {
			t.Fatalf("session affinity was falsely detected for %q", statement)
		}
	}
}

var schemaCacheDriverSequence atomic.Uint64

type schemaCacheTestState struct {
	mu         sync.Mutex
	opens      int
	latestID   int
	invalid    map[int]bool
	statements []string
}

func (state *schemaCacheTestState) openConnection() *schemaCacheTestConn {
	state.mu.Lock()
	defer state.mu.Unlock()
	state.opens++
	state.latestID = state.opens
	return &schemaCacheTestConn{state: state, id: state.latestID}
}

func (state *schemaCacheTestState) invalidateLatest() {
	state.mu.Lock()
	state.invalid[state.latestID] = true
	state.mu.Unlock()
}

func (state *schemaCacheTestState) isValid(id int) bool {
	state.mu.Lock()
	defer state.mu.Unlock()
	return !state.invalid[id]
}

func (state *schemaCacheTestState) record(statement string) {
	state.mu.Lock()
	state.statements = append(state.statements, statement)
	state.mu.Unlock()
}

func (state *schemaCacheTestState) executedStatements() []string {
	state.mu.Lock()
	defer state.mu.Unlock()
	return append([]string(nil), state.statements...)
}

func (state *schemaCacheTestState) openCount() int {
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.opens
}

type schemaCacheTestDriver struct {
	state *schemaCacheTestState
}

func (testDriver *schemaCacheTestDriver) Open(string) (driver.Conn, error) {
	return testDriver.state.openConnection(), nil
}

type schemaCacheTestConn struct {
	state *schemaCacheTestState
	id    int
}

func (*schemaCacheTestConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (*schemaCacheTestConn) Close() error                        { return nil }
func (*schemaCacheTestConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }

func (conn *schemaCacheTestConn) ExecContext(_ context.Context, statement string, _ []driver.NamedValue) (driver.Result, error) {
	conn.state.record(statement)
	return driver.RowsAffected(0), nil
}

func (conn *schemaCacheTestConn) IsValid() bool {
	return conn.state.isValid(conn.id)
}

func openSchemaCacheTestDB(t *testing.T, state *schemaCacheTestState) *sql.DB {
	t.Helper()
	driverName := fmt.Sprintf("vastbase-schema-cache-%d", schemaCacheDriverSequence.Add(1))
	sql.Register(driverName, &schemaCacheTestDriver{state: state})
	db, err := sql.Open(driverName, "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func mustSchemaConn(t *testing.T, server *server, schema string) *sql.Conn {
	t.Helper()
	conn, err := server.schemaConn(context.Background(), schema)
	if err != nil {
		t.Fatalf("schemaConn(%q): %v", schema, err)
	}
	return conn
}
