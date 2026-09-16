package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"sync/atomic"
	"testing"
)

func TestConnectionInfoAndTestConnectionExposeDatabaseInfo(t *testing.T) {
	db := openConnectionInfoTestDB(t)
	server := newServer()
	server.db = db
	server.mode = detectAgentMode(db, false)

	info, err := server.connectionInfo()
	if err != nil {
		t.Fatal(err)
	}
	assertVastbaseDatabaseInfo(t, info["databaseInfo"])

	testServer := newServer()
	testServer.openDatabase = func(connectParams, string) (*sql.DB, error) {
		return openConnectionInfoTestDB(t), nil
	}
	result, err := testServer.testConnection(connectParams{})
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := result["ok"].(bool); !ok {
		t.Fatalf("test_connection did not succeed: %v", result)
	}
	assertVastbaseDatabaseInfo(t, result["databaseInfo"])
}

func assertVastbaseDatabaseInfo(t *testing.T, value any) {
	t.Helper()
	info, ok := value.(map[string]string)
	if !ok {
		t.Fatalf("unexpected databaseInfo type: %T", value)
	}
	expected := map[string]string{
		"productName":            "Vastbase",
		"productVersion":         "Vastbase G100 V3.0.9",
		"unquotedIdentifierCase": "lower",
		"quotedIdentifierCase":   "mixed",
		"driverName":             agentDriverName,
		"driverVersion":          agentDriverVersion,
	}
	for key, expectedValue := range expected {
		if info[key] != expectedValue {
			t.Fatalf("databaseInfo[%s] = %q, want %q", key, info[key], expectedValue)
		}
	}
}

var connectionInfoDriverSequence atomic.Uint64

type connectionInfoTestDriver struct{}

func (*connectionInfoTestDriver) Open(string) (driver.Conn, error) {
	return &connectionInfoTestConn{}, nil
}

type connectionInfoTestConn struct{}

func (*connectionInfoTestConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (*connectionInfoTestConn) Close() error                        { return nil }
func (*connectionInfoTestConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }
func (*connectionInfoTestConn) Ping(context.Context) error          { return nil }

func (*connectionInfoTestConn) QueryContext(_ context.Context, _ string, _ []driver.NamedValue) (driver.Rows, error) {
	return &connectionInfoTestRows{
		columns: []string{"current_database", "current_user", "version", "current_schema"},
		values:  []driver.Value{"postgres", "vbadmin", "Vastbase G100 V3.0.9", "public"},
	}, nil
}

type connectionInfoTestRows struct {
	columns []string
	values  []driver.Value
	done    bool
}

func (rows *connectionInfoTestRows) Columns() []string { return rows.columns }
func (*connectionInfoTestRows) Close() error           { return nil }

func (rows *connectionInfoTestRows) Next(destination []driver.Value) error {
	if rows.done {
		return io.EOF
	}
	copy(destination, rows.values)
	rows.done = true
	return nil
}

func openConnectionInfoTestDB(t *testing.T) *sql.DB {
	t.Helper()
	driverName := fmt.Sprintf("vastbase-connection-info-%d", connectionInfoDriverSequence.Add(1))
	sql.Register(driverName, &connectionInfoTestDriver{})
	db, err := sql.Open(driverName, "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db
}
