package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
)

// manualTxStatement records one statement and the connection that ran it, so
// the test can prove that a transaction and its statements share one physical
// connection.
type manualTxStatement struct {
	conn *manualTxConn
	sql  string
}

// manualTxState records what the fake Kingbase connection was asked to do.
type manualTxState struct {
	mu         sync.Mutex
	statements []manualTxStatement
	// failExec makes the matching statement fail so the error paths can be
	// exercised.
	failExec func(query string) bool
	// nextConnID hands out a stable identity per physical connection.
	nextConnID int
}

func (state *manualTxState) snapshot() []manualTxStatement {
	state.mu.Lock()
	defer state.mu.Unlock()
	return append([]manualTxStatement{}, state.statements...)
}

type manualTxConnector struct {
	state *manualTxState
}

func (connector manualTxConnector) Connect(context.Context) (driver.Conn, error) {
	connector.state.mu.Lock()
	connector.state.nextConnID++
	id := connector.state.nextConnID
	connector.state.mu.Unlock()
	return &manualTxConn{state: connector.state, id: id}, nil
}

func (connector manualTxConnector) Driver() driver.Driver { return manualTxDriver{} }

type manualTxDriver struct{}

func (manualTxDriver) Open(string) (driver.Conn, error) { return nil, driver.ErrSkip }

type manualTxConn struct {
	state *manualTxState
	id    int
}

func (*manualTxConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }

func (*manualTxConn) Close() error { return nil }

func (*manualTxConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

func (connection *manualTxConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	connection.state.mu.Lock()
	connection.state.statements = append(connection.state.statements, manualTxStatement{conn: connection, sql: query})
	failExec := connection.state.failExec
	connection.state.mu.Unlock()
	if failExec != nil && failExec(query) {
		return nil, errors.New("statement failed")
	}
	return driver.RowsAffected(1), nil
}

func (connection *manualTxConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	connection.state.mu.Lock()
	connection.state.statements = append(connection.state.statements, manualTxStatement{conn: connection, sql: query})
	connection.state.mu.Unlock()
	switch {
	case strings.Contains(query, "dbx_identifier_probe"):
		return &valueRows{columns: []string{"dbx_identifier_probe"}, rows: [][]driver.Value{{int64(1)}}}, nil
	case strings.Contains(query, "version()"):
		return &valueRows{columns: []string{"version"}, rows: [][]driver.Value{{"KingbaseES V009R001C010"}}}, nil
	default:
		// Catalog probes and the mode detection queries answer with an empty
		// result: the fake only has to keep the connection lifecycle working.
		return &valueRows{columns: []string{"result"}}, nil
	}
}

func newManualTxServer(t *testing.T, state *manualTxState) *server {
	t.Helper()
	server := newServer()
	server.openDatabase = func(connectParams, string) (*sql.DB, error) {
		return sql.OpenDB(manualTxConnector{state: state}), nil
	}
	if err := server.connect(connectParams{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.disconnect() })
	return server
}

func statementsMatching(statements []manualTxStatement, want string) []manualTxStatement {
	matched := []manualTxStatement{}
	for _, statement := range statements {
		if strings.Contains(statement.sql, want) {
			matched = append(matched, statement)
		}
	}
	return matched
}

func statementsMatchingExact(statements []manualTxStatement, want string) []manualTxStatement {
	matched := []manualTxStatement{}
	for _, statement := range statements {
		if statement.sql == want {
			matched = append(matched, statement)
		}
	}
	return matched
}

func TestManualTransactionBeginsCommitsAndKeepsOneConnection(t *testing.T) {
	state := &manualTxState{}
	server := newManualTxServer(t, state)

	if err := server.beginManualTransaction("public"); err != nil {
		t.Fatal(err)
	}
	if !server.manualTxOpen || server.manualConn == nil {
		t.Fatal("begin_manual_transaction must pin the connection and open the transaction")
	}
	statements := state.snapshot()
	begin := statementsMatching(statements, "BEGIN")
	if len(begin) != 1 {
		t.Fatalf("expected one BEGIN statement, got %v", statements)
	}
	searchPath := statementsMatching(statements, "SET search_path TO")
	if len(searchPath) != 1 {
		t.Fatalf("expected the schema to be applied to the pinned connection, got %v", statements)
	}
	if searchPath[0].conn != begin[0].conn {
		t.Fatal("the schema and the transaction must run on the same connection")
	}

	// A statement inside the transaction must not release the pinned
	// connection: the transaction would end with the connection.
	if _, err := server.executeQuery(queryOptions{SQL: "SELECT 1"}); err != nil {
		t.Fatal(err)
	}
	if server.manualConn == nil || !server.manualTxOpen {
		t.Fatal("the transaction must survive the statement that used it")
	}
	statements = state.snapshot()
	selected := statementsMatchingExact(statements, "SELECT 1")
	if len(selected) != 1 {
		t.Fatalf("expected the statement to be executed once, got %v", statements)
	}
	if selected[0].conn != begin[0].conn {
		t.Fatal("the statement must run on the pinned transaction connection")
	}

	// A one-shot transaction would open a second transaction on the same
	// connection and commit the interactive one.
	if _, err := server.executeTransaction(map[string]json.RawMessage{
		"statements": []byte(`["SELECT 1"]`),
	}); err == nil || !strings.Contains(err.Error(), "manual transaction is open") {
		t.Fatalf("expected the one-shot transaction to be refused, got %v", err)
	}

	if err := server.commitManualTransaction(); err != nil {
		t.Fatal(err)
	}
	statements = state.snapshot()
	commit := statementsMatching(statements, "COMMIT")
	if len(commit) != 1 {
		t.Fatalf("expected one COMMIT statement, got %v", statements)
	}
	if commit[0].conn != begin[0].conn {
		t.Fatal("the commit must run on the connection that began the transaction")
	}
	if server.manualTxOpen || server.manualConn != nil {
		t.Fatal("commit must release the pinned connection")
	}
}

func TestManualTransactionRollbackDiscardsTheTransaction(t *testing.T) {
	state := &manualTxState{}
	server := newManualTxServer(t, state)

	if err := server.beginManualTransaction("public"); err != nil {
		t.Fatal(err)
	}
	if err := server.rollbackManualTransaction(); err != nil {
		t.Fatal(err)
	}
	statements := state.snapshot()
	rollback := statementsMatching(statements, "ROLLBACK")
	if len(rollback) != 1 {
		t.Fatalf("expected one ROLLBACK statement, got %v", statements)
	}
	if server.manualTxOpen || server.manualConn != nil {
		t.Fatal("rollback must release the pinned connection")
	}
}

func TestManualTransactionIsRolledBackWhenTheSessionCloses(t *testing.T) {
	state := &manualTxState{}
	server := newManualTxServer(t, state)

	if err := server.beginManualTransaction("public"); err != nil {
		t.Fatal(err)
	}
	if err := server.disconnect(); err != nil {
		t.Fatal(err)
	}
	statements := state.snapshot()
	if len(statementsMatching(statements, "ROLLBACK")) != 1 {
		t.Fatalf("an unfinished transaction must be rolled back when the session closes, got %v", statements)
	}
	if len(statementsMatching(statements, "COMMIT")) != 0 {
		t.Fatalf("an unfinished transaction must never be committed, got %v", statements)
	}
	if server.manualTxOpen || server.manualConn != nil {
		t.Fatal("closing the session must release the pinned connection")
	}
}

func TestManualTransactionRejectsASecondBegin(t *testing.T) {
	state := &manualTxState{}
	server := newManualTxServer(t, state)

	if err := server.beginManualTransaction("public"); err != nil {
		t.Fatal(err)
	}
	if err := server.beginManualTransaction("public"); err == nil {
		t.Fatal("a second begin_manual_transaction must be refused")
	}
}

func TestCommitWithoutManualTransactionIsRefused(t *testing.T) {
	state := &manualTxState{}
	server := newManualTxServer(t, state)

	if err := server.commitManualTransaction(); err == nil {
		t.Fatal("commit without an open transaction must be refused")
	}
	if err := server.rollbackManualTransaction(); err == nil {
		t.Fatal("rollback without an open transaction must be refused")
	}
}

// connectionID reports the identity of the driver connection behind a pooled
// connection, so the tests can tell a reused connection from a fresh one.
func connectionID(t *testing.T, conn *sql.Conn) int {
	t.Helper()
	id := 0
	if err := conn.Raw(func(raw any) error {
		fake, ok := raw.(*manualTxConn)
		if !ok {
			return errors.New("unexpected driver connection")
		}
		id = fake.id
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestManualTransactionCommitFailureIsCompensatedWithARollback(t *testing.T) {
	state := &manualTxState{failExec: func(query string) bool { return query == "COMMIT" }}
	server := newManualTxServer(t, state)

	if err := server.beginManualTransaction("public"); err != nil {
		t.Fatal(err)
	}
	pinnedID := connectionID(t, server.manualConn)

	if err := server.commitManualTransaction(); err == nil {
		t.Fatal("a failed COMMIT must be reported")
	}
	statements := state.snapshot()
	if len(statementsMatchingExact(statements, "ROLLBACK")) != 1 {
		t.Fatalf("a failed COMMIT must be compensated with a ROLLBACK, got %v", statements)
	}

	// The compensating rollback succeeded, so the connection returns to the
	// pool and stays usable.
	db, err := server.requireDB()
	if err != nil {
		t.Fatal(err)
	}
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if id := connectionID(t, conn); id != pinnedID {
		t.Fatalf("expected the connection to go back to the pool, got connection %d instead of %d", id, pinnedID)
	}
}

func TestManualTransactionRollbackFailureDropsTheConnection(t *testing.T) {
	state := &manualTxState{failExec: func(query string) bool { return query == "ROLLBACK" }}
	server := newManualTxServer(t, state)

	if err := server.beginManualTransaction("public"); err != nil {
		t.Fatal(err)
	}
	pinnedID := connectionID(t, server.manualConn)

	if err := server.rollbackManualTransaction(); err == nil {
		t.Fatal("a failed ROLLBACK must be reported")
	}

	// The rollback failed, so the server may still hold an open transaction on
	// that connection: the pool has to drop it instead of handing it to the
	// next statement.
	db, err := server.requireDB()
	if err != nil {
		t.Fatal(err)
	}
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if id := connectionID(t, conn); id == pinnedID {
		t.Fatal("the failed connection must be dropped instead of reused")
	}
}

func TestManualTransactionBeginFailureDropsTheConnection(t *testing.T) {
	state := &manualTxState{failExec: func(query string) bool { return query == "BEGIN" }}
	server := newManualTxServer(t, state)

	if err := server.beginManualTransaction("public"); err == nil {
		t.Fatal("a failed BEGIN must be reported")
	}
	if server.manualTxOpen || server.manualConn != nil {
		t.Fatal("a failed BEGIN must not leave a transaction open")
	}

	// The server may have started the transaction even though the client never
	// got the response, so the connection must not go back to the pool.
	beginConnID := 0
	for _, statement := range state.snapshot() {
		if statement.sql == "BEGIN" {
			beginConnID = statement.conn.id
		}
	}
	if beginConnID == 0 {
		t.Fatal("the BEGIN statement was not recorded")
	}
	db, err := server.requireDB()
	if err != nil {
		t.Fatal(err)
	}
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if id := connectionID(t, conn); id == beginConnID {
		t.Fatal("the connection that failed to BEGIN must be dropped instead of reused")
	}
}

func TestManualTransactionMetadataQueriesRunOnThePinnedConnection(t *testing.T) {
	state := &manualTxState{}
	server := newManualTxServer(t, state)

	if err := server.beginManualTransaction("public"); err != nil {
		t.Fatal(err)
	}
	pinnedID := connectionID(t, server.manualConn)
	before := len(state.snapshot())

	rows, err := server.metadataQuery("SELECT dbx_identifier_probe")
	if err != nil {
		t.Fatal(err)
	}
	rows.Close()

	var probe int
	if err := server.requireDBQueryRow("SELECT dbx_identifier_probe", &probe); err != nil {
		t.Fatal(err)
	}
	if probe != 1 {
		t.Fatalf("unexpected probe value %d", probe)
	}

	probes := 0
	for _, statement := range state.snapshot()[before:] {
		if !strings.Contains(statement.sql, "dbx_identifier_probe") {
			continue
		}
		probes++
		if statement.conn.id != pinnedID {
			t.Fatal("a metadata query must run on the pinned transaction connection")
		}
	}
	if probes != 2 {
		t.Fatalf("expected both metadata queries to run, got %d", probes)
	}
}
