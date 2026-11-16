package main

import (
	"context"
	"database/sql/driver"
	"errors"
	"sync"
	"testing"
	"time"
)

type plDebugTransactionTestConnector struct {
	base            plDebugConnectTestConnector
	begins          int
	rollbacks       int
	active          bool
	lifetime        context.Context
	rollbackErr     error
	rollbackStarted chan struct{}
	rollbackRelease chan struct{}
	beginStarted    chan struct{}
	beginRelease    chan struct{}
}

func (c *plDebugTransactionTestConnector) Driver() driver.Driver { return c.base.Driver() }
func (c *plDebugTransactionTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.base.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugTransactionTestConnection{plDebugConnectTestConnection: conn.(*plDebugConnectTestConnection), state: c}, nil
}

type plDebugTransactionTestConnection struct {
	*plDebugConnectTestConnection
	state *plDebugTransactionTestConnector
}

func (c *plDebugTransactionTestConnection) BeginTx(ctx context.Context, _ driver.TxOptions) (driver.Tx, error) {
	c.state.base.mu.Lock()
	c.state.begins++
	c.state.active = true
	c.state.lifetime = ctx
	c.state.base.mu.Unlock()
	if c.state.beginStarted != nil {
		close(c.state.beginStarted)
	}
	if c.state.beginRelease != nil {
		<-c.state.beginRelease
	}
	return &plDebugTransactionTestTx{state: c.state}, nil
}
func (c *plDebugTransactionTestConnection) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}
func (c *plDebugTransactionTestConnection) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.base.mu.Lock()
	active := c.state.active
	c.state.base.mu.Unlock()
	if !active {
		return nil, errors.New("target did not use its original transaction")
	}
	return c.plDebugConnectTestConnection.ExecContext(ctx, query, args)
}

type plDebugTransactionTestTx struct {
	state *plDebugTransactionTestConnector
}

func (*plDebugTransactionTestTx) Commit() error {
	return errors.New("debugger must not commit its target")
}
func (tx *plDebugTransactionTestTx) Rollback() error {
	c := tx.state
	c.base.mu.Lock()
	c.rollbacks++
	c.base.mu.Unlock()
	if c.rollbackStarted != nil {
		close(c.rollbackStarted)
	}
	if c.rollbackRelease != nil {
		<-c.rollbackRelease
	}
	c.base.mu.Lock()
	defer c.base.mu.Unlock()
	if c.rollbackErr == nil {
		c.active = false
	}
	return c.rollbackErr
}

func TestPLDebugNativeTransactionUsesOriginalDebuggeeAndOutlivesRequest(t *testing.T) {
	first := &plDebugConnectTestConnector{}
	second := &plDebugTransactionTestConnector{}
	r := plDebugPairTestRuntime(first, second)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	tx, err := s.server.beginNativeDebuggeeTransaction()
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.server.beginNativeDebuggeeTransaction()
	if err != nil || again != tx || second.begins != 1 {
		t.Fatal("original transaction was duplicated")
	}
	ctx, cancel := context.WithCancel(context.Background())
	if _, err := tx.ExecContext(ctx, "BEGIN NULL; END;"); err != nil {
		t.Fatal(err)
	}
	cancel()
	if second.lifetime.Err() != nil {
		t.Fatal("request cancellation ended the original transaction")
	}
	resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || second.rollbacks != 1 || second.base.closes != 1 || first.closes != 1 || second.base.execs != 1 {
		t.Fatalf("rollback=%d target=%d close=%d/%d result=%+v", second.rollbacks, second.base.execs, second.base.closes, first.closes, resp)
	}
}

func TestPLDebugNativeTransactionWaitsForOriginalTargetBeforeRollback(t *testing.T) {
	first := &plDebugConnectTestConnector{}
	second := &plDebugTransactionTestConnector{base: plDebugConnectTestConnector{execStarted: make(chan struct{}), execRelease: make(chan struct{}), breakStarted: make(chan struct{})}}
	defer close(second.base.execRelease)
	r := plDebugPairTestRuntime(first, second)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a","driver_profile":"oci"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	tx, err := s.server.beginNativeDebuggeeTransaction()
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := tx.ExecContext(context.Background(), "BEGIN NULL; END;"); done <- err }()
	select {
	case <-second.base.execStarted:
	case <-time.After(time.Second):
		t.Fatal("target did not dispatch")
	}
	resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || second.rollbacks != 0 || second.base.closes != 0 || first.closes != 0 {
		t.Fatal("cleanup passed the original executing target")
	}
	select {
	case <-second.base.breakStarted:
	case <-time.After(time.Second):
		t.Fatal("close did not request original cancellation")
	}
	second.base.execRelease <- struct{}{}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("target did not return")
	}
	resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || second.rollbacks != 1 || second.base.closes != 1 || first.closes != 1 {
		t.Fatalf("rollback=%d close=%d/%d result=%+v", second.rollbacks, second.base.closes, first.closes, resp)
	}
}

func TestPLDebugNativeRollbackFailureRetainsOriginalTransactionFacts(t *testing.T) {
	first := &plDebugConnectTestConnector{}
	second := &plDebugTransactionTestConnector{rollbackErr: errors.New("rollback result unknown")}
	r := plDebugPairTestRuntime(first, second)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	if _, err := s.server.beginNativeDebuggeeTransaction(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
		if resp.Error == nil {
			t.Fatal("failed rollback was reported released")
		}
	}
	if second.rollbacks != 1 || second.base.closes != 0 || first.closes != 0 || len(r.sessions) != 1 {
		t.Fatal("failed rollback was retried, forgotten or closed over")
	}
}

func TestPLDebugNativeBlockedRollbackUsesOriginalDeadlineAndCompletion(t *testing.T) {
	first := &plDebugConnectTestConnector{closeStarted: make(chan struct{})}
	second := &plDebugTransactionTestConnector{base: plDebugConnectTestConnector{closeStarted: make(chan struct{}), breakStarted: make(chan struct{})}, rollbackStarted: make(chan struct{}), rollbackRelease: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(second.rollbackRelease) })
	r := plDebugPairTestRuntime(first, second)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a","driver_profile":"oci"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	if _, err := s.server.beginNativeDebuggeeTransaction(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(20 * time.Millisecond)
	s.server.plCleanupDeadline = deadline
	resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || first.closes != 0 || second.base.closes != 0 {
		t.Fatal("blocked rollback was reported released")
	}
	select {
	case <-second.rollbackStarted:
	default:
		t.Fatal("original rollback did not start")
	}
	s.server.plDebugMu.Lock()
	original := s.server.plTxRollbackDone
	s.server.plDebugMu.Unlock()
	resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || s.server.plTxRollbackDone != original || !s.server.plCleanupDeadline.Equal(deadline) || second.rollbacks != 1 {
		t.Fatal("repeated cleanup restarted rollback or its budget")
	}
	select {
	case <-second.base.breakStarted:
	case <-time.After(time.Second):
		t.Fatal("rollback budget did not reach original cancellation")
	}
	release.Do(func() { close(second.rollbackRelease) })
	select {
	case <-original:
	case <-time.After(time.Second):
		t.Fatal("late original rollback did not complete")
	}
	_, _ = r.handleLine(`{"id":4,"method":"close_session","params":{"agentSessionId":"a"}}`)
	select {
	case <-second.base.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("original debuggee did not retire")
	}
	a := s.server.plDebuggeeAllocation
	a.mu.Lock()
	closed := a.closeDone
	a.mu.Unlock()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("debuggee raw Close did not complete")
	}
	_, _ = r.handleLine(`{"id":5,"method":"close_session","params":{"agentSessionId":"a"}}`)
	select {
	case <-first.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("original controller did not retire")
	}
	a = s.server.plAllocation
	a.mu.Lock()
	closed = a.closeDone
	a.mu.Unlock()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("controller raw Close did not complete")
	}
	resp, _ = r.handleLine(`{"id":6,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || second.rollbacks != 1 || second.base.closes != 1 || first.closes != 1 || len(r.sessions) != 0 {
		t.Fatalf("rollback=%d close=%d/%d retained=%d result=%+v", second.rollbacks, second.base.closes, first.closes, len(r.sessions), resp)
	}
}

func TestPLDebugNativeLateBeginRetainsRollbackWithoutDeliveringTransaction(t *testing.T) {
	first := &plDebugConnectTestConnector{}
	second := &plDebugTransactionTestConnector{base: plDebugConnectTestConnector{breakStarted: make(chan struct{})}, beginStarted: make(chan struct{}), beginRelease: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(second.beginRelease) })
	r := plDebugPairTestRuntime(first, second)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a","driver_profile":"oci"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	done := make(chan error, 1)
	go func() {
		tx, err := s.server.beginNativeDebuggeeTransaction()
		if tx != nil {
			done <- errors.New("retired transaction was delivered")
			return
		}
		done <- err
	}()
	select {
	case <-second.beginStarted:
	case <-time.After(time.Second):
		t.Fatal("original BeginTx did not start")
	}
	resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || first.closes != 0 || second.base.closes != 0 || second.rollbacks != 0 {
		t.Fatal("cleanup passed the original in-flight transaction begin")
	}
	select {
	case <-second.base.breakStarted:
	case <-time.After(time.Second):
		t.Fatal("transaction begin cancellation was not requested")
	}
	release.Do(func() { close(second.beginRelease) })
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("retired begin was accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("late BeginTx did not drain")
	}
	if s.server.plDebuggeeTx == nil {
		t.Fatal("late original transaction was forgotten")
	}
	resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || second.begins != 1 || second.rollbacks != 1 || second.base.execs != 0 || second.base.closes != 1 || first.closes != 1 {
		t.Fatalf("begin=%d rollback=%d target=%d close=%d/%d result=%+v", second.begins, second.rollbacks, second.base.execs, second.base.closes, first.closes, resp)
	}
}
