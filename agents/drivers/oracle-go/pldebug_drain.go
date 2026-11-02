package main

import "time"

// EOF and a shutdown acknowledgement retire admission, not physical ownership.
// Once stdin is gone, only original completions or the Core's dedicated-process
// isolation can finish this responsibility.
func (r *runtimeServer) awaitNativeDrain() {
	for {
		r.mu.RLock()
		sessions := make([]*server, 0, len(r.sessions))
		for _, session := range r.sessions {
			sessions = append(sessions, session.server)
		}
		entries := make([]*plDebugNativeEntry, 0, len(r.plNativeEntries))
		for _, entry := range r.plNativeEntries {
			entries = append(entries, entry)
		}
		r.mu.RUnlock()
		var pending <-chan struct{}
		for _, entry := range entries {
			entry.mu.Lock()
			for _, done := range []chan struct{}{entry.startOwnerDone, entry.startDone, entry.captureDone, entry.actionDone, entry.cleanupDone, entry.outputRecoveryDone, entry.continuationDone} {
				// captureDone is not created work until a target worker is registered.
				if done == entry.captureDone && entry.session == nil {
					continue
				}
				if next := plDebugPendingCompletion(done); next != nil {
					pending = next
					break
				}
			}
			entry.mu.Unlock()
			if pending != nil {
				break
			}
		}
		if pending == nil {
			for _, server := range sessions {
				pending = server.pendingNativeCompletion()
				if pending != nil {
					break
				}
			}
		}
		if pending != nil {
			<-pending
			_ = r.closeAllSessions()
			continue
		}
		if len(sessions) == 0 {
			return
		}
		// No outstanding completion can prove release. Do not retry failed I/O,
		// erase the owner or exit and implicitly disconnect its target. A distant
		// timer keeps this intentional wait distinct from a Go runtime deadlock;
		// it performs no polling or database work. Core may isolate this process.
		for {
			time.Sleep(time.Duration(1<<63 - 1))
		}
	}
}

func plDebugPendingCompletion(done <-chan struct{}) <-chan struct{} {
	if done == nil {
		return nil
	}
	select {
	case <-done:
		return nil
	default:
		return done
	}
}

func (s *server) pendingNativeCompletion() <-chan struct{} {
	s.plDebugMu.Lock()
	allocations := []*plDebugAllocation{s.plDebuggeeAllocation, s.plAllocation}
	for _, done := range []chan struct{}{s.plDebuggeeOpenDone, s.plTxBeginDone, s.plTxRollbackDone} {
		if pending := plDebugPendingCompletion(done); pending != nil {
			s.plDebugMu.Unlock()
			return pending
		}
	}
	s.plDebugMu.Unlock()
	for _, allocation := range allocations {
		if allocation == nil {
			continue
		}
		allocation.mu.Lock()
		var pending <-chan struct{}
		if call := allocation.active; call != nil {
			pending = plDebugPendingCompletion(call.done)
			if pending == nil && call.cancelClaimed {
				pending = plDebugPendingCompletion(call.cancelDone)
			}
		}
		if pending == nil {
			pending = plDebugPendingCompletion(allocation.closeDone)
		}
		if pending == nil {
			for statement := range allocation.statements {
				if allocation.unknown && !statement.closeStarted {
					continue
				}
				if pending = plDebugPendingCompletion(statement.closeDone); pending != nil {
					break
				}
			}
		}
		if pending == nil {
			for rows := range allocation.rows {
				if allocation.unknown && !rows.closeStarted {
					continue
				}
				if pending = plDebugPendingCompletion(rows.closeDone); pending != nil {
					break
				}
			}
		}
		allocation.mu.Unlock()
		if pending != nil {
			return pending
		}
	}
	return nil
}

func (e *plDebugNativeEntry) pendingCleanupContinuation() <-chan struct{} {
	e.mu.Lock()
	for _, done := range []chan struct{}{e.startDone, e.actionDone, e.outputRecoveryDone} {
		if pending := plDebugPendingCompletion(done); pending != nil {
			e.mu.Unlock()
			return pending
		}
	}
	if e.session != nil {
		if pending := plDebugPendingCompletion(e.captureDone); pending != nil {
			e.mu.Unlock()
			return pending
		}
	}
	outputReady := !e.targetDispatched || (e.captureFinished && (e.capture.OutputComplete || e.capture.Truncated))
	if e.outputRecoveryAttempted && e.outputRecoveryError == "" && (e.outputRecoveryCapture.OutputComplete || e.outputRecoveryCapture.Truncated) {
		outputReady = true
	}
	allowStatement := e.capture.ReferencesPending || e.outputRecoveryCapture.ReferencesPending
	abortFailed := e.abortError != "" && !e.targetReturned
	e.mu.Unlock()
	if pending := e.server.pendingNativeCompletion(); pending != nil {
		return pending
	}
	if !outputReady || abortFailed {
		return nil
	}
	e.server.plDebugMu.Lock()
	allocations := []*plDebugAllocation{e.server.plAllocation, e.server.plDebuggeeAllocation}
	rollbackFailed := e.server.plTxRollbackDone != nil && e.server.plTxRollbackErr != nil
	e.server.plDebugMu.Unlock()
	if rollbackFailed {
		return nil
	}
	for i, a := range allocations {
		if a == nil {
			continue
		}
		a.mu.Lock()
		statementsOK := len(a.statements) == 0 || (i == 1 && allowStatement && len(a.statements) == 1)
		ready := !a.opening && !a.unknown && a.active == nil && a.closingRows == 0 && a.closingStatements == 0 && len(a.rows) == 0 && statementsOK
		a.mu.Unlock()
		if !ready {
			return nil
		}
	}
	// A completion may have arrived between the failed pass and this snapshot.
	// Consume the now-ready original stage once instead of losing that event.
	done := make(chan struct{})
	close(done)
	return done
}

func (e *plDebugNativeEntry) resumeCleanupAfter(next <-chan struct{}, done chan struct{}, deadline time.Time) {
	defer close(done)
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	completed := false
	select {
	case <-next:
		completed = true
	case <-timer.C:
	}
	e.mu.Lock()
	e.continuationWaiting = false
	closed := e.releaseState == "released"
	e.mu.Unlock()
	if completed && !closed && time.Now().Before(deadline) {
		_, _ = e.close()
	}
}
