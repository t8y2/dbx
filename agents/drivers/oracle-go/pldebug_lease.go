package main

import "time"

const plDebugNativeLease = 120 * time.Second

func (e *plDebugNativeEntry) heartbeat() map[string]interface{} {
	e.mu.Lock()
	if e.closeRequested {
		result := e.snapshotLocked()
		e.mu.Unlock()
		return result
	}
	now := time.Now()
	if !now.Before(e.leaseDeadline) {
		e.markLeaseExpiredLocked()
		result := e.snapshotLocked()
		e.mu.Unlock()
		go func() { _, _ = e.close() }()
		return result
	}
	e.leaseDeadline = now.Add(plDebugNativeLease)
	e.leaseTimer.Reset(plDebugNativeLease)
	result := e.snapshotLocked()
	e.mu.Unlock()
	return result
}

func (e *plDebugNativeEntry) expireLease() {
	e.mu.Lock()
	if e.closeRequested {
		e.mu.Unlock()
		return
	}
	remaining := time.Until(e.leaseDeadline)
	if remaining > 0 {
		// Reset can race an already queued callback. The current deadline is
		// authoritative; an old timer cannot close a renewed session.
		e.leaseTimer.Reset(remaining)
		e.mu.Unlock()
		return
	}
	e.markLeaseExpiredLocked()
	e.mu.Unlock()
	_, _ = e.close()
}

func (e *plDebugNativeEntry) markLeaseExpiredLocked() {
	e.closeRequested, e.cancelRequested = true, true
	e.closeReason, e.state = "lease_expired", "closing"
	if e.cleanupDeadline.IsZero() {
		e.cleanupDeadline = time.Now().Add(plDebugReleaseTimeout)
	}
}
