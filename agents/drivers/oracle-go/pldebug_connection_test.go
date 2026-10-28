package main

import (
	"bytes"
	"context"
	"database/sql/driver"
	"errors"
	"io"
	"runtime"
	"sync"
	"testing"
	"time"
)

func TestPLDebugAgentEOFRetiresBeforeWaitingForOpen(t *testing.T) {
	plDebugAgentRetiresBeforeWaitingForOpen(t, false)
}

func TestPLDebugAgentShutdownRetiresBeforeWaitingForOpen(t *testing.T) {
	plDebugAgentRetiresBeforeWaitingForOpen(t, true)
}

func plDebugAgentRetiresBeforeWaitingForOpen(t *testing.T, shutdown bool) {
	t.Helper()
	c := &plDebugConnectTestConnector{started: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(c.release) })
	r := plDebugConnectTestRuntime(c)
	input, writer := io.Pipe()
	defer input.Close()
	var output, diagnostics bytes.Buffer
	done := make(chan struct{})
	go func() { runOracleAgent(input, &output, &diagnostics, r); close(done) }()
	if _, err := io.WriteString(writer, `{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`+"\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-c.started:
	case <-time.After(time.Second):
		t.Fatal("open did not start")
	}
	if shutdown {
		if _, err := io.WriteString(writer, `{"id":2,"method":"shutdown"}`+"\n"); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	s, _ := r.session("a")
	a := s.server.plAllocation
	deadline := time.NewTimer(200 * time.Millisecond)
	defer deadline.Stop()
	for {
		a.mu.Lock()
		retiring := a.retiring
		a.mu.Unlock()
		if retiring {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("EOF waited for the open request before retiring its allocation")
		default:
			runtime.Gosched()
		}
	}
	select {
	case <-done:
		t.Fatal("agent exited while original open was still in flight")
	default:
	}
	release.Do(func() { close(c.release) })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("EOF cleanup did not drain the late original connection")
	}
	if c.connects != 1 || c.closes != 1 || len(r.sessions) != 0 {
		t.Fatalf("connect=%d close=%d retained=%d", c.connects, c.closes, len(r.sessions))
	}
}

type plDebugConnectTestConnector struct {
	mu           sync.Mutex
	connects     int
	closes       int
	started      chan struct{}
	release      chan struct{}
	connectErr   error
	closeErr     error
	execs        int
	execErr      error
	closeStarted chan struct{}
	closeRelease chan struct{}
	execStarted  chan struct{}
	execRelease  chan struct{}
	breakStarted chan struct{}
	breakRelease chan struct{}
	breakErr     error
	breaks       int
}

func (c *plDebugConnectTestConnector) Driver() driver.Driver { return &oracleManualTxDriver{} }
func (c *plDebugConnectTestConnector) Connect(context.Context) (driver.Conn, error) {
	c.mu.Lock()
	c.connects++
	c.mu.Unlock()
	if c.started != nil {
		close(c.started)
	}
	if c.release != nil {
		<-c.release
	}
	if c.connectErr != nil {
		return nil, c.connectErr
	}
	return &plDebugConnectTestConnection{connector: c}, nil
}

type plDebugConnectTestConnection struct{ connector *plDebugConnectTestConnector }

func (c *plDebugConnectTestConnection) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepare")
}
func (c *plDebugConnectTestConnection) Begin() (driver.Tx, error) {
	return nil, errors.New("unexpected begin")
}
func (c *plDebugConnectTestConnection) Close() error {
	if c.connector.closeStarted != nil {
		close(c.connector.closeStarted)
	}
	if c.connector.closeRelease != nil {
		<-c.connector.closeRelease
	}
	c.connector.mu.Lock()
	defer c.connector.mu.Unlock()
	c.connector.closes++
	return c.connector.closeErr
}

func TestPLDebugRuntimeBlockedRawCloseUsesOriginalDeadline(t *testing.T) {
	c := &plDebugConnectTestConnector{closeStarted: make(chan struct{}), closeRelease: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(c.closeRelease) })
	r := plDebugConnectTestRuntime(c)
	opened, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
	if opened.Error != nil {
		t.Fatal(opened.Error)
	}
	s, _ := r.session("a")
	a := s.server.plAllocation
	a.cleanupDeadline = time.Now().Add(20 * time.Millisecond)
	done := make(chan response, 1)
	go func() {
		resp, _ := r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
		done <- resp
	}()
	select {
	case <-c.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("raw Close did not start")
	}
	select {
	case resp := <-done:
		if resp.Error == nil || len(r.sessions) != 1 {
			t.Fatal("blocked raw Close reported release or forgot the owner")
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("raw Close escaped the original cleanup deadline")
	}
	resp, _ := r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || time.Until(a.cleanupDeadline) > 0 {
		t.Fatal("repeat close reset the original deadline")
	}
	release.Do(func() { close(c.closeRelease) })
	select {
	case <-a.closeDone:
	case <-time.After(time.Second):
		t.Fatal("late raw Close did not complete")
	}
	resp, _ = r.handleLine(`{"id":4,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || c.closes != 1 || len(r.sessions) != 0 {
		t.Fatalf("late completion was not consumed by the original owner: %+v", resp)
	}
}

func (c *plDebugConnectTestConnection) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	if c.connector.execStarted != nil {
		close(c.connector.execStarted)
	}
	if c.connector.execRelease != nil {
		<-c.connector.execRelease
	}
	c.connector.mu.Lock()
	defer c.connector.mu.Unlock()
	c.connector.execs++
	return driver.RowsAffected(1), c.connector.execErr
}

func TestPLDebugRuntimeCloseCannotPassAnInFlightThinCall(t *testing.T) {
	c := &plDebugConnectTestConnector{execStarted: make(chan struct{}), execRelease: make(chan struct{}), closeStarted: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(c.execRelease) })
	r := plDebugConnectTestRuntime(c)
	opened, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
	if opened.Error != nil {
		t.Fatal(opened.Error)
	}
	s, _ := r.session("a")
	done := make(chan error, 1)
	go func() {
		_, err := s.server.plConnection.ExecContext(context.Background(), "BEGIN NULL; END;")
		done <- err
	}()
	select {
	case <-c.execStarted:
	case <-time.After(time.Second):
		t.Fatal("target did not dispatch")
	}
	closed := make(chan response, 1)
	go func() {
		resp, _ := r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
		closed <- resp
	}()
	select {
	case <-c.closeStarted:
		t.Fatal("raw Close ran while the original target was in flight")
	case resp := <-closed:
		if resp.Error == nil {
			t.Fatal("in-flight target reported released")
		}
	case <-time.After(time.Second):
		t.Fatal("close waited behind the active target")
	}
	release.Do(func() { close(c.execRelease) })
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("target did not return")
	}
	select {
	case <-c.closeStarted:
		t.Fatal("thin cancellation with unknown watcher drain allowed raw Close")
	default:
	}
}

func TestPLDebugAllocationDoesNotReconnectAfterExecutedBadConnection(t *testing.T) {
	c := &plDebugConnectTestConnector{execErr: driver.ErrBadConn}
	a := &plDebugAllocation{connector: c}
	db, conn, err := a.open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	defer conn.Close()
	if _, err := conn.ExecContext(context.Background(), "BEGIN NULL; END;"); err == nil {
		t.Fatal("lost execution result was accepted")
	}
	if _, err := db.ExecContext(context.Background(), "BEGIN NULL; END;"); err == nil {
		t.Fatal("replacement connection was admitted")
	}
	if c.connects != 1 || c.execs != 1 || c.closes != 1 {
		t.Fatalf("connect=%d exec=%d close=%d", c.connects, c.execs, c.closes)
	}
}

func plDebugConnectTestRuntime(connector driver.Connector) *runtimeServer {
	r := newRuntimeServer()
	r.plDebugRuntime = true
	r.plDebugConnector = func(connectParams) (driver.Connector, error) { return connector, nil }
	return r
}

func TestPLDebugRuntimeOwnsFirstConnectionBeforeStart(t *testing.T) {
	c := &plDebugConnectTestConnector{}
	r := plDebugConnectTestRuntime(c)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	if s.server.plConnection == nil || s.server.db.Stats().MaxOpenConnections != 1 {
		t.Fatal("first physical connection was not pinned with a one-connection budget")
	}
	for _, method := range []string{"open_session", "test_connection", "validate_session", "connect", "execute_query"} {
		request := `{"id":2,"method":"` + method + `","params":{"agentSessionId":"b","sql":"BEGIN NULL; END;"}}`
		resp, _ = r.handleLine(request)
		if resp.Error == nil {
			t.Fatalf("%s admitted another connection or ordinary call", method)
		}
	}
	resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	if c.connects != 1 || c.closes != 1 || len(r.sessions) != 0 {
		t.Fatalf("connect=%d close=%d retained=%d", c.connects, c.closes, len(r.sessions))
	}
}

func TestPLDebugRuntimeRetainsOpaqueConnectAndFailedClose(t *testing.T) {
	for _, phase := range []string{"connect", "close"} {
		t.Run(phase, func(t *testing.T) {
			c := &plDebugConnectTestConnector{}
			if phase == "connect" {
				c.connectErr = errors.New("opaque initialization failure")
			} else {
				c.closeErr = errors.New("raw close failed")
			}
			r := plDebugConnectTestRuntime(c)
			opened, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
			if (opened.Error != nil) != (phase == "connect") {
				t.Fatalf("unexpected open: %+v", opened)
			}
			closed, _ := r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
			if closed.Error == nil || len(r.sessions) != 1 {
				t.Fatal("unknown original allocation was forgotten")
			}
			retry, _ := r.handleLine(`{"id":3,"method":"open_session","params":{"agentSessionId":"a"}}`)
			if retry.Error == nil || c.connects != 1 {
				t.Fatal("unknown connection was retried")
			}
		})
	}
}

func TestPLDebugRuntimeCloseDuringOpenKeepsOriginalOwner(t *testing.T) {
	c := &plDebugConnectTestConnector{started: make(chan struct{}), release: make(chan struct{})}
	r := plDebugConnectTestRuntime(c)
	done := make(chan response, 1)
	go func() {
		resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
		done <- resp
	}()
	select {
	case <-c.started:
	case <-time.After(time.Second):
		t.Fatal("connect did not start")
	}
	resp, _ := r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || len(r.sessions) != 1 {
		t.Fatal("in-flight allocation was forgotten or reported released")
	}
	close(c.release)
	select {
	case resp := <-done:
		if resp.Error == nil {
			t.Fatal("late connection was handed to retired session")
		}
	case <-time.After(time.Second):
		t.Fatal("late connect did not drain")
	}
	resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || c.connects != 1 || c.closes != 1 || len(r.sessions) != 0 {
		t.Fatalf("late connection not closed exactly once: %+v", resp)
	}
}
