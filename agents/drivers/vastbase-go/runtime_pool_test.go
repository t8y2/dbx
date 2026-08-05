package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConnectionRuntimeReusesAuthenticatedValidator(t *testing.T) {
	state := &runtimePoolTestState{}
	opener := runtimePoolTestOpener(t, state)
	connectionRuntime := newConnectionRuntime()
	t.Cleanup(func() { _ = connectionRuntime.close() })

	if err := connectionRuntime.validate(connectParams{}, opener); err != nil {
		t.Fatal(err)
	}
	if err := connectionRuntime.validate(connectParams{}, opener); err != nil {
		t.Fatal(err)
	}
	if opens := state.openCount(); opens != 1 {
		t.Fatalf("validator did not reuse its authenticated connection: opened %d", opens)
	}
	if pings := state.pingCount(); pings != 2 {
		t.Fatalf("unexpected validator ping count: %d", pings)
	}
}

func TestConnectionRuntimeRetainsMetadataPoolConnections(t *testing.T) {
	state := &runtimePoolTestState{}
	connectionRuntime := newConnectionRuntime()
	t.Cleanup(func() { _ = connectionRuntime.close() })
	if err := connectionRuntime.validate(connectParams{}, runtimePoolTestOpener(t, state)); err != nil {
		t.Fatal(err)
	}

	acquirePool := func() {
		connections := make([]*sql.Conn, 0, defaultValidatorPoolSize)
		for range defaultValidatorPoolSize {
			conn, err := connectionRuntime.database().Conn(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			connections = append(connections, conn)
		}
		for _, conn := range connections {
			if err := conn.Close(); err != nil {
				t.Fatal(err)
			}
		}
	}

	acquirePool()
	if opens := state.openCount(); opens != defaultValidatorPoolSize {
		t.Fatalf("metadata pool opened %d connections, want %d", opens, defaultValidatorPoolSize)
	}
	acquirePool()
	if opens := state.openCount(); opens != defaultValidatorPoolSize {
		t.Fatalf("metadata pool discarded idle connections and reopened %d total", opens)
	}
}

func TestConnectWithRuntimeUsesSharedMetadataUntilSessionAffinity(t *testing.T) {
	state := &runtimePoolTestState{}
	opener := runtimePoolTestOpener(t, state)
	connectionRuntime := newConnectionRuntime()
	t.Cleanup(func() { _ = connectionRuntime.close() })
	server := newServer()
	server.openDatabase = opener

	if err := server.connectWithRuntime(connectParams{}, connectionRuntime); err != nil {
		t.Fatal(err)
	}
	if opens := state.openCount(); opens != 1 {
		t.Fatalf("logical connect opened a private physical connection: %d", opens)
	}
	if err := server.validateConnection(); err != nil {
		t.Fatal(err)
	}
	if opens := state.openCount(); opens != 1 {
		t.Fatalf("stateless metadata opened a private physical connection: %d", opens)
	}
	server.noteSQLSessionState("SET ROLE analyst")
	if err := server.validateConnection(); err != nil {
		t.Fatal(err)
	}
	if opens := state.openCount(); opens != 2 {
		t.Fatalf("session-affine metadata did not open its private physical connection: %d", opens)
	}
	if err := server.disconnect(); err != nil {
		t.Fatal(err)
	}
}

func TestConnectionRuntimeSharesListTablesStatementAcrossSessions(t *testing.T) {
	state := &runtimePoolTestState{}
	opener := runtimePoolTestOpener(t, state)
	connectionRuntime := newConnectionRuntime()
	first := newServer()
	first.openDatabase = opener
	second := newServer()
	second.openDatabase = opener

	if err := first.connectWithRuntime(connectParams{}, connectionRuntime); err != nil {
		t.Fatal(err)
	}
	if err := second.connectWithRuntime(connectParams{}, connectionRuntime); err != nil {
		t.Fatal(err)
	}
	for _, server := range []*server{first, second} {
		rows, err := server.cachedListTablesQuery("SELECT value FROM tables WHERE schema = $1", "public")
		if err != nil {
			t.Fatal(err)
		}
		if err := rows.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if prepares := state.prepareCount(); prepares != 1 {
		t.Fatalf("shared list-tables statement prepared %d times, want 1", prepares)
	}
	if err := first.disconnect(); err != nil {
		t.Fatal(err)
	}
	if err := second.disconnect(); err != nil {
		t.Fatal(err)
	}
	if err := connectionRuntime.close(); err != nil {
		t.Fatal(err)
	}
	if closes := state.statementCloseCount(); closes != 1 {
		t.Fatalf("shared list-tables statement closed %d times, want 1", closes)
	}
}

func TestConnectionRuntimeLimitsConcurrentOperations(t *testing.T) {
	t.Setenv("DBX_AGENT_VASTBASE_MAX_CONCURRENT_OPERATIONS", "2")
	connectionRuntime := newConnectionRuntime()
	var active atomic.Int32
	var peak atomic.Int32
	var waitGroup sync.WaitGroup
	for range 8 {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			release, err := connectionRuntime.acquire(false)
			if err != nil {
				t.Errorf("acquire permit: %v", err)
				return
			}
			current := active.Add(1)
			for current > peak.Load() && !peak.CompareAndSwap(peak.Load(), current) {
			}
			time.Sleep(10 * time.Millisecond)
			active.Add(-1)
			release()
		}()
	}
	waitGroup.Wait()
	if value := peak.Load(); value != 2 {
		t.Fatalf("operation concurrency peak = %d, want 2", value)
	}
}

func TestConnectionRuntimeKeySeparatesCredentialsWithoutExposingThem(t *testing.T) {
	first := connectionRuntimeKey(connectParams{Host: "db", Database: "app", Username: "user", Password: "secret-a"})
	second := connectionRuntimeKey(connectParams{Host: "db", Database: "app", Username: "user", Password: "secret-b"})
	if first == second {
		t.Fatal("different credentials shared one runtime key")
	}
	if len(first) != 64 || first == "secret-a" {
		t.Fatalf("runtime key is not a SHA-256 digest: %q", first)
	}
}

var runtimePoolDriverSequence atomic.Uint64

type runtimePoolTestState struct {
	opens           atomic.Int32
	pings           atomic.Int32
	prepares        atomic.Int32
	statementCloses atomic.Int32
}

func (state *runtimePoolTestState) openCount() int32           { return state.opens.Load() }
func (state *runtimePoolTestState) pingCount() int32           { return state.pings.Load() }
func (state *runtimePoolTestState) prepareCount() int32        { return state.prepares.Load() }
func (state *runtimePoolTestState) statementCloseCount() int32 { return state.statementCloses.Load() }

type runtimePoolTestDriver struct {
	state *runtimePoolTestState
}

func (testDriver *runtimePoolTestDriver) Open(string) (driver.Conn, error) {
	testDriver.state.opens.Add(1)
	return &runtimePoolTestConn{state: testDriver.state}, nil
}

type runtimePoolTestConn struct {
	state *runtimePoolTestState
}

func (conn *runtimePoolTestConn) Prepare(string) (driver.Stmt, error) {
	conn.state.prepares.Add(1)
	return &runtimePoolTestStmt{state: conn.state}, nil
}

func (*runtimePoolTestConn) Close() error              { return nil }
func (*runtimePoolTestConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

func (conn *runtimePoolTestConn) Ping(context.Context) error {
	conn.state.pings.Add(1)
	return nil
}

type runtimePoolTestStmt struct {
	state *runtimePoolTestState
}

func (stmt *runtimePoolTestStmt) Close() error {
	stmt.state.statementCloses.Add(1)
	return nil
}

func (*runtimePoolTestStmt) NumInput() int { return -1 }
func (*runtimePoolTestStmt) Exec([]driver.Value) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}
func (*runtimePoolTestStmt) Query([]driver.Value) (driver.Rows, error) {
	return &runtimePoolTestRows{}, nil
}

type runtimePoolTestRows struct{}

func (*runtimePoolTestRows) Columns() []string         { return []string{"value"} }
func (*runtimePoolTestRows) Close() error              { return nil }
func (*runtimePoolTestRows) Next([]driver.Value) error { return io.EOF }

func runtimePoolTestOpener(t *testing.T, state *runtimePoolTestState) agentDBOpener {
	t.Helper()
	driverName := fmt.Sprintf("vastbase-runtime-pool-%d", runtimePoolDriverSequence.Add(1))
	sql.Register(driverName, &runtimePoolTestDriver{state: state})
	return func(connectParams, string) (*sql.DB, error) {
		db, err := sql.Open(driverName, "")
		if err != nil {
			return nil, err
		}
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
		return db, nil
	}
}
