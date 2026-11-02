package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"reflect"
	"sync"
	"testing"
	"time"
)

type plDebugPreparedTestConnector struct {
	base           *plDebugConnectTestConnector
	stmtCloses     int
	stmtClosed     chan struct{}
	rowOpen        bool
	rowCloses      int
	rowNextStarted chan struct{}
	rowNextRelease chan struct{}
	rowClosed      chan struct{}
}

func (c *plDebugPreparedTestConnector) Driver() driver.Driver { return c.base.Driver() }
func (c *plDebugPreparedTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.base.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugPreparedTestConnection{Conn: conn, state: c}, nil
}

type plDebugPreparedTestConnection struct {
	driver.Conn
	state *plDebugPreparedTestConnector
}

func (c *plDebugPreparedTestConnection) Prepare(string) (driver.Stmt, error) {
	return &plDebugPreparedTestStatement{state: c.state}, nil
}
func (c *plDebugPreparedTestConnection) Break() error {
	return (&plDebugConnectTestConnection{connector: c.state.base}).Break()
}

type plDebugPreparedTestStatement struct{ state *plDebugPreparedTestConnector }

func plDebugAcceptTestStatementValue(value *driver.NamedValue) error {
	if typ := reflect.TypeOf(value.Value); typ != nil && typ.PkgPath() == "github.com/godror/godror" && typ.Name() == "Option" {
		return driver.ErrRemoveArgument
	}
	return nil
}

func (*plDebugPreparedTestStatement) CheckNamedValue(value *driver.NamedValue) error {
	return plDebugAcceptTestStatementValue(value)
}

func TestPLDebugPreparedFallbackPreservesOutputBindUntilStatementValidation(t *testing.T) {
	base := &plDebugConnectTestConnector{}
	fixture := &plDebugPreparedTestConnector{base: base}
	allocation := &plDebugAllocation{connector: fixture, oci: true}
	db, conn, err := allocation.open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { conn.Close(); db.Close() }()
	var value int64
	if _, err = conn.ExecContext(context.Background(), "BEGIN :1 := 1; END;", sql.Out{Dest: &value}); err != nil {
		t.Fatal(err)
	}
	if fixture.stmtCloses != 1 || base.execs != 1 {
		t.Fatal("output bind was rejected before the original prepared statement")
	}
}

func (s *plDebugPreparedTestStatement) Close() error {
	s.state.base.mu.Lock()
	defer s.state.base.mu.Unlock()
	if s.state.rowOpen {
		return errors.New("statement closed before its rows")
	}
	s.state.stmtCloses++
	if s.state.stmtClosed != nil {
		close(s.state.stmtClosed)
	}
	return nil
}

func TestPLDebugPreparedExecutionDefersImplicitCloseUntilBreakDrains(t *testing.T) {
	base := &plDebugConnectTestConnector{execStarted: make(chan struct{}), execRelease: make(chan struct{}), breakStarted: make(chan struct{}), breakRelease: make(chan struct{})}
	c := &plDebugPreparedTestConnector{base: base, stmtClosed: make(chan struct{})}
	var targetRelease, breakRelease sync.Once
	defer targetRelease.Do(func() { close(base.execRelease) })
	defer breakRelease.Do(func() { close(base.breakRelease) })
	r := plDebugConnectTestRuntime(c)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a","driver_profile":"oci"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	a := s.server.plAllocation
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := s.server.plConnection.ExecContext(ctx, "BEGIN NULL; END;"); done <- err }()
	select {
	case <-base.execStarted:
	case <-time.After(time.Second):
		t.Fatal("prepared target did not start")
	}
	a.mu.Lock()
	call := a.active
	a.mu.Unlock()
	cancel()
	select {
	case <-base.breakStarted:
	case <-time.After(time.Second):
		t.Fatal("prepared call cancellation did not reach Break")
	}
	targetRelease.Do(func() { close(base.execRelease) })
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("target result waited behind Break")
	}
	select {
	case <-c.stmtClosed:
		t.Fatal("implicit statement Close ran before Break drained")
	default:
	}
	if _, err := s.server.plConnection.ExecContext(context.Background(), "BEGIN NULL; END;"); err == nil {
		t.Fatal("new prepare passed the pending cancellation")
	}
	a.mu.Lock()
	var owned *plDebugStatement
	for stmt := range a.statements {
		owned = stmt
	}
	a.mu.Unlock()
	if owned == nil {
		t.Fatal("implicit statement was forgotten")
	}
	breakRelease.Do(func() { close(base.breakRelease) })
	select {
	case <-call.cancelDone:
	case <-time.After(time.Second):
		t.Fatal("Break did not drain")
	}
	select {
	case <-c.stmtClosed:
	case <-time.After(time.Second):
		t.Fatal("original owner did not resume statement close")
	}
	a.mu.Lock()
	closed := owned.closeDone
	a.mu.Unlock()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("statement reference did not drain")
	}
	base.execStarted = nil
	base.execRelease = nil
	c.stmtClosed = nil
	if _, err := s.server.plConnection.ExecContext(context.Background(), "BEGIN NULL; END;"); err != nil {
		t.Fatal(err)
	}
	resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || c.stmtCloses != 2 || base.closes != 1 || base.breaks != 1 {
		t.Fatalf("stmt=%d close=%d break=%d result=%+v", c.stmtCloses, base.closes, base.breaks, resp)
	}
}
func (*plDebugPreparedTestStatement) NumInput() int { return -1 }
func (s *plDebugPreparedTestStatement) Exec([]driver.Value) (driver.Result, error) {
	return s.ExecContext(context.Background(), nil)
}
func (s *plDebugPreparedTestStatement) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return (&plDebugConnectTestConnection{connector: s.state.base}).ExecContext(ctx, "", args)
}
func (s *plDebugPreparedTestStatement) Query([]driver.Value) (driver.Rows, error) {
	s.state.base.mu.Lock()
	s.state.rowOpen = true
	s.state.base.mu.Unlock()
	return &plDebugPreparedTestRows{state: s.state}, nil
}

type plDebugPreparedTestRows struct {
	state *plDebugPreparedTestConnector
	read  bool
}

func (*plDebugPreparedTestRows) Columns() []string { return []string{"N"} }
func (r *plDebugPreparedTestRows) Close() error {
	r.state.base.mu.Lock()
	defer r.state.base.mu.Unlock()
	r.state.rowOpen = false
	r.state.rowCloses++
	if r.state.rowClosed != nil {
		close(r.state.rowClosed)
	}
	return nil
}
func (r *plDebugPreparedTestRows) Next(dest []driver.Value) error {
	if r.read {
		return io.EOF
	}
	if r.state.rowNextStarted != nil {
		close(r.state.rowNextStarted)
	}
	if r.state.rowNextRelease != nil {
		<-r.state.rowNextRelease
	}
	r.read = true
	dest[0] = int64(7)
	return nil
}
func (*plDebugPreparedTestRows) ColumnTypeDatabaseTypeName(int) string { return "NUMBER" }
func (*plDebugPreparedTestRows) ColumnTypeScanType(int) reflect.Type   { return reflect.TypeOf(int64(0)) }

func TestPLDebugPreparedRowsKeepTheirOriginalReferenceAndMetadata(t *testing.T) {
	c := &plDebugPreparedTestConnector{base: &plDebugConnectTestConnector{}}
	r := plDebugConnectTestRuntime(c)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a","driver_profile":"oci"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	rows, err := s.server.plConnection.QueryContext(context.Background(), "SELECT 7 FROM DUAL")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	types, err := rows.ColumnTypes()
	if err != nil || len(types) != 1 || types[0].DatabaseTypeName() != "NUMBER" || types[0].ScanType() != reflect.TypeOf(int64(0)) {
		t.Fatalf("metadata was not preserved: %v %v", types, err)
	}
	if !rows.Next() {
		t.Fatalf("original cursor was not readable: %v", rows.Err())
	}
	var value int64
	if err := rows.Scan(&value); err != nil || value != 7 {
		t.Fatalf("value=%d error=%v", value, err)
	}
	if rows.Next() || rows.Err() != nil {
		t.Fatalf("cursor did not end normally: %v", rows.Err())
	}
	resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || c.rowCloses != 1 || c.stmtCloses != 1 || c.base.closes != 1 {
		t.Fatalf("rows=%d stmt=%d connection=%d result=%+v", c.rowCloses, c.stmtCloses, c.base.closes, resp)
	}
}

func TestPLDebugPreparedStatementKeepsPhysicalOwnerUntilReleased(t *testing.T) {
	c := &plDebugPreparedTestConnector{base: &plDebugConnectTestConnector{closeStarted: make(chan struct{})}}
	r := plDebugConnectTestRuntime(c)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a","driver_profile":"oci"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	stmt, err := s.server.plConnection.PrepareContext(context.Background(), "BEGIN NULL; END;")
	if err != nil {
		t.Fatal(err)
	}
	defer stmt.Close()
	resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil {
		t.Fatal("physical release was reported while the prepared statement was still retained")
	}
	select {
	case <-c.base.closeStarted:
		t.Fatal("raw Close ran before the prepared statement was released")
	default:
	}
	if err := stmt.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-c.base.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("released statement did not resume original retirement")
	}
	a := s.server.plAllocation
	a.mu.Lock()
	done := a.closeDone
	a.mu.Unlock()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("raw Close did not finish")
	}
	resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || c.stmtCloses != 1 || c.base.closes != 1 {
		t.Fatalf("statement=%d physical=%d result=%+v", c.stmtCloses, c.base.closes, resp)
	}
}
