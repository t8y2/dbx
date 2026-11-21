package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"time"
)

func (s *server) beginNativeDebuggeeTransaction() (*sql.Tx, error) {
	s.plDebugMu.Lock()
	if s.plRetiring {
		s.plDebugMu.Unlock()
		return nil, errors.New("the original PL/SQL runtime is retiring")
	}
	if s.plTxBeginDone != nil {
		done := s.plTxBeginDone
		s.plDebugMu.Unlock()
		<-done
		s.plDebugMu.Lock()
		tx, err := s.plDebuggeeTx, s.plTxBeginErr
		s.plDebugMu.Unlock()
		if err != nil {
			return nil, err
		}
		return tx, nil
	}
	s.plTxBeginDone = make(chan struct{})
	s.plDebugMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), plDebugOpenTimeout)
	defer cancel()
	conn, err := s.openNativeDebuggee(ctx)
	var tx *sql.Tx
	if err == nil {
		_, err = s.plDebuggeeAllocation.exec(ctx, func(context.Context) (driver.Result, error) {
			var beginErr error
			// The transaction outlives a single RPC or statement budget. Only its
			// original owner rolls it back after the target and output have drained.
			tx, beginErr = conn.BeginTx(context.Background(), nil)
			return nil, beginErr
		})
	}
	s.plDebugMu.Lock()
	if err == nil && s.plRetiring {
		err = errors.New("the PL/SQL runtime retired while beginning its original transaction")
	}
	s.plDebuggeeTx, s.plTxBeginErr = tx, err
	close(s.plTxBeginDone)
	s.plDebugMu.Unlock()
	if err != nil {
		return nil, err
	}
	return tx, nil
}

func (s *server) rollbackNativeDebuggeeTransaction() error {
	s.plDebugMu.Lock()
	if s.plDebuggeeTx == nil {
		s.plDebugMu.Unlock()
		return nil
	}
	if s.plCleanupDeadline.IsZero() {
		s.plCleanupDeadline = time.Now().Add(plDebugReleaseTimeout)
	}
	deadline := s.plCleanupDeadline
	if s.plTxRollbackDone == nil {
		a := s.plDebuggeeAllocation
		a.mu.Lock()
		active := a.active
		ready := active == nil && !a.unknown && len(a.rows) == 0 && len(a.statements) == 0
		a.mu.Unlock()
		if !ready {
			retiring := s.plRetiring
			s.plDebugMu.Unlock()
			if retiring && active != nil {
				go a.cancelCall(active)
			}
			return errPLDebugAllocationUnknown
		}
		s.plTxRollbackDone = make(chan struct{})
		tx := s.plDebuggeeTx
		go func() {
			ctx, cancel := context.WithDeadline(context.Background(), deadline)
			defer cancel()
			_, err := a.exec(ctx, func(context.Context) (driver.Result, error) { return nil, tx.Rollback() })
			s.plDebugMu.Lock()
			s.plTxRollbackErr = err
			close(s.plTxRollbackDone)
			s.plDebugMu.Unlock()
		}()
	}
	done := s.plTxRollbackDone
	s.plDebugMu.Unlock()
	select {
	case <-done:
		return s.nativeRollbackResult()
	default:
	}
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case <-done:
		return s.nativeRollbackResult()
	case <-timer.C:
		return errPLDebugAllocationUnknown
	}
}

func (s *server) nativeRollbackResult() error {
	s.plDebugMu.Lock()
	defer s.plDebugMu.Unlock()
	return s.plTxRollbackErr
}
