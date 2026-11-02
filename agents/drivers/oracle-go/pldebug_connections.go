package main

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

func (s *server) openNativeDebuggee(ctx context.Context) (*sql.Conn, error) {
	s.plDebugMu.Lock()
	if s.plRetiring || s.plAllocation == nil || s.plConnector == nil {
		s.plDebugMu.Unlock()
		return nil, errors.New("the original dedicated PL/SQL runtime cannot allocate a debuggee")
	}
	if s.plDebuggeeOpenDone != nil {
		done := s.plDebuggeeOpenDone
		s.plDebugMu.Unlock()
		select {
		case <-done:
			s.plDebugMu.Lock()
			conn, err := s.plDebuggeeConnection, s.plDebuggeeOpenErr
			s.plDebugMu.Unlock()
			if err != nil {
				return nil, err
			}
			return conn, err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	s.plAllocation.mu.Lock()
	ready := s.plAllocation.raw != nil && !s.plAllocation.opening && !s.plAllocation.retiring && !s.plAllocation.unknown && !s.plAllocation.closed
	s.plAllocation.mu.Unlock()
	if !ready {
		s.plDebugMu.Unlock()
		return nil, errors.New("the original debugger connection is not available")
	}
	connector, err := s.plConnector(s.params)
	if err != nil {
		s.plDebugMu.Unlock()
		return nil, err
	}
	allocation := &plDebugAllocation{connector: connector, oci: usesOCIProfile(s.params)}
	s.plDebuggeeAllocation = allocation
	s.plDebuggeeOpenDone = make(chan struct{})
	s.plDebugMu.Unlock()
	openCtx, cancel := context.WithTimeout(ctx, plDebugOpenTimeout)
	db, conn, err := allocation.open(openCtx)
	cancel()
	s.plDebugMu.Lock()
	if s.plRetiring && err == nil {
		err = errors.New("the original PL/SQL runtime retired while the debuggee was opening")
	}
	s.plDebuggeeDB, s.plDebuggeeConnection, s.plDebuggeeOpenErr = db, conn, err
	close(s.plDebuggeeOpenDone)
	s.plDebugMu.Unlock()
	if err != nil {
		return nil, err
	}
	return conn, nil
}

func (s *server) closeNativeAllocations() error {
	s.plDebugMu.Lock()
	s.plRetiring = true
	debuggee := s.plDebuggeeAllocation
	opened := s.plDebuggeeOpenDone
	transactionOpening := s.plTxBeginDone
	deadline := s.plCleanupDeadline
	if deadline.IsZero() {
		deadline = time.Now().Add(plDebugReleaseTimeout)
	}
	for _, allocation := range []*plDebugAllocation{s.plAllocation, debuggee} {
		if allocation == nil {
			continue
		}
		allocation.mu.Lock()
		if !allocation.cleanupDeadline.IsZero() && allocation.cleanupDeadline.Before(deadline) {
			deadline = allocation.cleanupDeadline
		}
		allocation.mu.Unlock()
	}
	s.plCleanupDeadline = deadline
	for _, allocation := range []*plDebugAllocation{s.plAllocation, debuggee} {
		if allocation == nil {
			continue
		}
		allocation.mu.Lock()
		if allocation.cleanupDeadline.IsZero() || deadline.Before(allocation.cleanupDeadline) {
			allocation.cleanupDeadline = deadline
		}
		allocation.mu.Unlock()
	}
	s.plDebugMu.Unlock()
	if transactionOpening != nil {
		select {
		case <-transactionOpening:
		default:
			if debuggee != nil {
				debuggee.mu.Lock()
				active, opening := debuggee.active, debuggee.opening
				debuggee.mu.Unlock()
				if active != nil {
					go debuggee.cancelCall(active)
				} else if opening {
					_ = debuggee.close()
				}
			}
			return errPLDebugAllocationUnknown
		}
		if err := s.rollbackNativeDebuggeeTransaction(); err != nil {
			return err
		}
	}
	// Keep the controller available while target execution or target release is
	// unknown. A controller disconnect is not a target-stop acknowledgement.
	if debuggee != nil {
		if err := debuggee.close(); err != nil {
			return err
		}
		select {
		case <-opened:
		default:
			return errPLDebugAllocationUnknown
		}
	}
	return s.plAllocation.close()
}
