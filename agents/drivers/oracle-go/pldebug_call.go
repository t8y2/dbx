package main

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
)

type plDebugPhysicalCall struct {
	cancel         context.CancelFunc
	done           chan struct{}
	cancelDone     chan struct{}
	finished       bool
	cancelClaimed  bool
	cancelFinished bool
	rows           *plDebugRows
}

func (a *plDebugAllocation) exec(ctx context.Context, run func(context.Context) (driver.Result, error)) (driver.Result, error) {
	private, call, err := a.beginCall(ctx)
	if err != nil {
		return nil, err
	}
	defer a.finishCall(call)
	return run(private)
}

func (a *plDebugAllocation) beginCall(ctx context.Context) (context.Context, *plDebugPhysicalCall, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	private, cancel := context.WithCancel(context.Background())
	call := &plDebugPhysicalCall{cancel: cancel, done: make(chan struct{}), cancelDone: make(chan struct{})}
	a.mu.Lock()
	if a.retiring || a.unknown || a.closed || a.active != nil || a.closingStatements != 0 || a.closingRows != 0 {
		a.mu.Unlock()
		cancel()
		return nil, nil, errors.New("PL/SQL original physical connection is not available for another call")
	}
	a.active = call
	a.mu.Unlock()
	go func() {
		select {
		case <-ctx.Done():
			a.cancelCall(call)
		case <-call.done:
		}
	}()
	return private, call, nil
}

func (a *plDebugAllocation) finishCall(call *plDebugPhysicalCall) {
	a.mu.Lock()
	if !call.finished {
		call.finished = true
		close(call.done)
		a.completeCallLocked(call)
	}
	a.mu.Unlock()
}

func (a *plDebugAllocation) claimCancellationLocked(call *plDebugPhysicalCall) bool {
	if a.active != call || call.finished || call.cancelClaimed {
		return false
	}
	call.cancelClaimed = true
	if !a.oci {
		a.unknown = true
	}
	return true
}

func (a *plDebugAllocation) cancelCall(call *plDebugPhysicalCall) {
	a.mu.Lock()
	claimed := a.claimCancellationLocked(call)
	a.mu.Unlock()
	if claimed {
		a.runCancellation(call)
	}
}

func (a *plDebugAllocation) runCancellation(call *plDebugPhysicalCall) {
	var err error
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("PL/SQL driver cancellation panicked: %v", recovered)
		}
		a.mu.Lock()
		call.cancelFinished = true
		if err != nil {
			a.unknown = true
		}
		a.completeCallLocked(call)
		close(call.cancelDone)
		a.mu.Unlock()
	}()
	if !a.oci {
		call.cancel()
		return
	}
	if a.breakCall == nil {
		err = errors.New("original OCI connection has no synchronous Break handle")
		return
	}
	err = a.breakCall()
}

func (a *plDebugAllocation) completeCallLocked(call *plDebugPhysicalCall) {
	if a.active != call || !call.finished || (call.cancelClaimed && !call.cancelFinished) {
		return
	}
	a.active = nil
	call.cancel()
	a.resumeReferencesLocked()
	if a.retiring && !a.unknown {
		go func() { _ = a.close() }()
	}
}

func (a *plDebugAllocation) resumeReferencesLocked() {
	if a.active != nil || a.unknown {
		return
	}
	for rows := range a.rows {
		if rows.closeRequested && !rows.closeStarted {
			go func(r *plDebugRows) { _ = r.Close() }(rows)
		}
	}
	if len(a.rows) != 0 {
		return
	}
	for stmt := range a.statements {
		if stmt.closeRequested && !stmt.closeStarted {
			go func(s *plDebugStatement) { _ = s.Close() }(stmt)
		}
	}
}
