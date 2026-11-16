package main

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestPLDebugRowsCancellationDrainsBeforeRowsStatementAndPhysicalClose(t *testing.T) {
	base := &plDebugConnectTestConnector{breakStarted: make(chan struct{}), breakRelease: make(chan struct{}), closeStarted: make(chan struct{})}
	c := &plDebugPreparedTestConnector{base: base, rowNextStarted: make(chan struct{}), rowNextRelease: make(chan struct{}), rowClosed: make(chan struct{})}
	var nextRelease, breakRelease sync.Once
	defer nextRelease.Do(func() { close(c.rowNextRelease) })
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
	rows, err := s.server.plConnection.QueryContext(ctx, "SELECT 7 FROM DUAL")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	done := make(chan struct{})
	go func() { _ = rows.Next(); _ = rows.Close(); close(done) }()
	select {
	case <-c.rowNextStarted:
	case <-time.After(time.Second):
		t.Fatal("cursor fetch did not start")
	}
	cancel()
	select {
	case <-base.breakStarted:
	case <-time.After(time.Second):
		t.Fatal("cursor cancellation did not reach Break")
	}
	select {
	case <-c.rowClosed:
		t.Fatal("rows closed while fetch and Break were in flight")
	default:
	}
	nextRelease.Do(func() { close(c.rowNextRelease) })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cursor close blocked behind Break")
	}
	select {
	case <-c.rowClosed:
		t.Fatal("rows closed before cancellation drained")
	default:
	}
	resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil {
		t.Fatal("pending cursor cancellation reported physical release")
	}
	breakRelease.Do(func() { close(base.breakRelease) })
	select {
	case <-base.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("original owner did not finish rows and statement cleanup")
	}
	a.mu.Lock()
	closed := a.closeDone
	a.mu.Unlock()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("physical close did not finish")
	}
	resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || c.rowCloses != 1 || c.stmtCloses != 1 || base.closes != 1 || base.breaks != 1 {
		t.Fatalf("rows=%d stmt=%d raw=%d break=%d result=%+v", c.rowCloses, c.stmtCloses, base.closes, base.breaks, resp)
	}
}
