package main

import (
	"testing"
	"time"
)

func TestPLDebugNativeLeaseRenewalAndExpiryUseOriginalClose(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), cleanupStarted: make(chan struct{}), cleanupRelease: make(chan struct{})}
	first := &plDebugManagerTestConnector{engine: e}
	second := &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{output: "lease output😀\n", complete: 1}}
	second.base.tx.rollbackStarted = make(chan struct{})
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "lease-1", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
	r.mu.RLock()
	entry := r.plNativeEntries["lease-1"]
	r.mu.RUnlock()
	entry.mu.Lock()
	oldDeadline := time.Now().Add(30 * time.Millisecond)
	entry.leaseDeadline = oldDeadline
	entry.leaseTimer.Reset(time.Until(oldDeadline))
	startDeadline := entry.startDeadline
	entry.mu.Unlock()
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_heartbeat", map[string]interface{}{"debugId": "lease-1"}))
	if state["closeRequested"] != false {
		t.Fatal("valid heartbeat closed original target")
	}
	<-time.After(time.Until(oldDeadline) + 10*time.Millisecond)
	entry.expireLease()
	entry.mu.Lock()
	if !entry.leaseDeadline.After(oldDeadline) || entry.startDeadline != startDeadline || entry.closeRequested {
		entry.mu.Unlock()
		t.Fatal("old callback closed renewed target or renewed business budget")
	}
	entry.leaseDeadline = time.Now().Add(10 * time.Millisecond)
	entry.leaseTimer.Reset(time.Until(entry.leaseDeadline))
	entry.mu.Unlock()
	select {
	case <-second.base.tx.rollbackStarted:
	case <-time.After(time.Second):
		t.Fatal("expired lease did not reach original target/output/rollback cleanup")
	}
	entry.mu.Lock()
	done, deadline := entry.cleanupDone, entry.cleanupDeadline
	entry.mu.Unlock()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("lease cleanup did not finish")
	}
	state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_heartbeat", map[string]interface{}{"debugId": "lease-1"}))
	if state["closeReason"] != "lease_expired" || state["releaseState"] != "released" || state["executionOutcome"] != "cancelled" || state["outputComplete"] != true || e.targetAttempts != 1 || e.cleanupAttempts != 1 || e.controls != 2 || second.base.tx.rollbacks != 1 {
		t.Fatalf("lease expiry lost original lifecycle facts: %#v", state)
	}
	entry.mu.Lock()
	unchanged := entry.cleanupDeadline.Equal(deadline)
	entry.mu.Unlock()
	if !unchanged {
		t.Fatal("late heartbeat renewed original cleanup deadline")
	}
}

func TestPLDebugNativeOverdueHeartbeatPublishesCloseWithoutWaitingForDriver(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), abortStarted: make(chan struct{}), abortRelease: make(chan struct{}), abortCancelled: make(chan struct{})}
	first, second := &plDebugManagerTestConnector{engine: e}, &plDebugManagerTestConnector{engine: e}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "overdue", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
	r.mu.RLock()
	entry := r.plNativeEntries["overdue"]
	r.mu.RUnlock()
	entry.mu.Lock()
	entry.leaseTimer.Stop()
	entry.leaseDeadline = time.Now().Add(-time.Second)
	entry.cleanupDeadline = time.Now().Add(25 * time.Millisecond)
	deadline := entry.cleanupDeadline
	entry.mu.Unlock()
	heartbeat := make(chan response, 1)
	go func() {
		heartbeat <- plDebugManagerRPC(t, r, "pl_debug_heartbeat", map[string]interface{}{"debugId": "overdue"})
	}()
	select {
	case resp := <-heartbeat:
		state := plDebugManagerSnapshot(t, resp)
		if state["closeRequested"] != true || state["closeReason"] != "lease_expired" {
			t.Fatalf("overdue heartbeat revived expired lease: %#v", state)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("heartbeat waited behind driver cleanup")
	}
	select {
	case <-e.abortStarted:
	case <-time.After(time.Second):
		t.Fatal("overdue heartbeat did not request original close")
	}
	select {
	case <-e.abortCancelled:
	case <-time.After(time.Second):
		t.Fatal("original close deadline was not consumed")
	}
	close(e.abortRelease)
	entry.mu.Lock()
	done := entry.cleanupDone
	entry.mu.Unlock()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("late original abort did not finish its cleanup pass")
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_heartbeat", map[string]interface{}{"debugId": "overdue"}))
	entry.mu.Lock()
	unchanged := entry.cleanupDeadline.Equal(deadline)
	entry.mu.Unlock()
	if !unchanged || e.controls != 1 || first.base.tx.base.closes != 0 || second.base.tx.base.closes != 0 {
		t.Fatal("late heartbeat replayed cleanup or lost original unknown handles")
	}
}
