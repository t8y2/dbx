package main

import (
	"context"
	"database/sql/driver"
	"errors"
	"sync"
	"testing"
	"time"
)

func plDebugPairTestRuntime(first, second driver.Connector) *runtimeServer {
	r := plDebugConnectTestRuntime(first)
	builds := 0
	r.plDebugConnector = func(connectParams) (driver.Connector, error) {
		builds++
		if builds == 1 {
			return first, nil
		}
		return second, nil
	}
	return r
}

func TestPLDebugSecondAllocationIsSharedByConcurrentOriginalWaiters(t *testing.T) {
	first, second := &plDebugConnectTestConnector{}, &plDebugConnectTestConnector{started: make(chan struct{}), release: make(chan struct{})}
	r := plDebugPairTestRuntime(first, second)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	var release sync.Once
	defer release.Do(func() { close(second.release) })
	var waits sync.WaitGroup
	errorsFound := make(chan error, 8)
	for i := 0; i < 8; i++ {
		waits.Add(1)
		go func() {
			defer waits.Done()
			_, err := s.server.openNativeDebuggee(context.Background())
			errorsFound <- err
		}()
	}
	select {
	case <-second.started:
	case <-time.After(time.Second):
		t.Fatal("second connection did not start")
	}
	release.Do(func() { close(second.release) })
	waits.Wait()
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatal(err)
		}
	}
	if first.connects != 1 || second.connects != 1 || s.server.plConnection == s.server.plDebuggeeConnection {
		t.Fatal("the original two allocations were duplicated or aliased")
	}
	resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || first.closes != 1 || second.closes != 1 {
		t.Fatalf("first=%d second=%d result=%+v", first.closes, second.closes, resp)
	}
}

func TestPLDebugSecondAllocationUnknownKeepsControllerAndCapacity(t *testing.T) {
	first, second := &plDebugConnectTestConnector{}, &plDebugConnectTestConnector{connectErr: errors.New("opaque second initialize failure")}
	r := plDebugPairTestRuntime(first, second)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	for i := 0; i < 2; i++ {
		if _, err := s.server.openNativeDebuggee(context.Background()); err == nil {
			t.Fatal("opaque connect failure was reported successful")
		}
	}
	resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || len(r.sessions) != 1 || first.closes != 0 || second.connects != 1 {
		t.Fatal("unknown debuggee lost its controller, owner, or capacity")
	}
}

func TestPLDebugControllerCloseWaitsForOriginalDebuggeePhysicalClose(t *testing.T) {
	first, second := &plDebugConnectTestConnector{}, &plDebugConnectTestConnector{closeStarted: make(chan struct{}), closeRelease: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(second.closeRelease) })
	r := plDebugPairTestRuntime(first, second)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	if _, err := s.server.openNativeDebuggee(context.Background()); err != nil {
		t.Fatal(err)
	}
	a := s.server.plDebuggeeAllocation
	a.cleanupDeadline = time.Now().Add(20 * time.Millisecond)
	resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || first.closes != 0 {
		t.Fatal("controller closed before the debuggee's raw Close completed")
	}
	if !s.server.plAllocation.cleanupDeadline.Equal(a.cleanupDeadline) {
		t.Fatal("controller cleanup received a fresh deadline")
	}
	release.Do(func() { close(second.closeRelease) })
	select {
	case <-a.closeDone:
	case <-time.After(time.Second):
		t.Fatal("debuggee raw Close did not complete")
	}
	resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		controller := s.server.plAllocation
		controller.mu.Lock()
		closed := controller.closeDone
		controller.mu.Unlock()
		select {
		case <-closed:
		case <-time.After(time.Second):
			t.Fatal("late controller Close did not finish")
		}
		resp, _ = r.handleLine(`{"id":4,"method":"close_session","params":{"agentSessionId":"a"}}`)
	}
	if resp.Error != nil || first.closes != 1 || second.closes != 1 {
		t.Fatalf("first=%d second=%d result=%+v", first.closes, second.closes, resp)
	}
}

func TestPLDebugSecondOpenRetirementKeepsControllerUntilLateCompletion(t *testing.T) {
	first, second := &plDebugConnectTestConnector{}, &plDebugConnectTestConnector{started: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(second.release) })
	r := plDebugPairTestRuntime(first, second)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	done := make(chan error, 1)
	go func() {
		conn, err := s.server.openNativeDebuggee(context.Background())
		if conn != nil {
			done <- errors.New("retired debuggee handle was delivered")
			return
		}
		done <- err
	}()
	select {
	case <-second.started:
	case <-time.After(time.Second):
		t.Fatal("second Connect did not start")
	}
	resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || first.closes != 0 || len(r.sessions) != 1 {
		t.Fatal("in-flight debuggee lost the original controller or owner")
	}
	release.Do(func() { close(second.release) })
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("late retired connection was reported ready")
		}
	case <-time.After(time.Second):
		t.Fatal("late second Connect did not drain")
	}
	resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || first.closes != 1 || second.closes != 1 || len(r.sessions) != 0 {
		t.Fatalf("first=%d second=%d retained=%d result=%+v", first.closes, second.closes, len(r.sessions), resp)
	}
}
