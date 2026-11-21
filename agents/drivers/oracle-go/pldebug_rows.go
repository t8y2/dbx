package main

import (
	"context"
	"database/sql/driver"
	"fmt"
	"io"
	"reflect"
	"time"
)

type plDebugRows struct {
	driver.Rows
	allocation     *plDebugAllocation
	call           *plDebugPhysicalCall
	reading        bool
	closeRequested bool
	closeStarted   bool
	closeDone      chan struct{}
	closeDeadline  time.Time
	closeErr       error
}

func (a *plDebugAllocation) query(ctx context.Context, run func(context.Context) (driver.Rows, error)) (driver.Rows, error) {
	private, call, err := a.beginCall(ctx)
	if err != nil {
		return nil, err
	}
	transferred := false
	defer func() {
		if !transferred {
			a.finishCall(call)
		}
	}()
	raw, err := run(private)
	if err != nil {
		return nil, err
	}
	rows := &plDebugRows{Rows: raw, allocation: a, call: call}
	a.mu.Lock()
	if a.rows == nil {
		a.rows = make(map[*plDebugRows]struct{})
	}
	a.rows[rows] = struct{}{}
	call.rows = rows
	retiring := a.retiring
	a.mu.Unlock()
	transferred = true
	if retiring {
		go func() { _ = rows.Close() }()
	}
	return rows, nil
}

func (r *plDebugRows) read(run func() error) error {
	a := r.allocation
	a.mu.Lock()
	if r.closeRequested || a.unknown || a.retiring {
		a.mu.Unlock()
		return errPLDebugAllocationUnknown
	}
	r.reading = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		r.reading = false
		requested := r.closeRequested
		a.mu.Unlock()
		if requested {
			go func() { _ = r.Close() }()
		}
	}()
	return run()
}

func (r *plDebugRows) Next(dest []driver.Value) error {
	return r.read(func() error { return r.Rows.Next(dest) })
}

func (r *plDebugRows) Close() error {
	a := r.allocation
	a.mu.Lock()
	if !r.closeRequested {
		r.closeRequested = true
		r.closeDone = make(chan struct{})
		a.closingRows++
		r.closeDeadline = time.Now().Add(plDebugReleaseTimeout)
		if !a.cleanupDeadline.IsZero() && a.cleanupDeadline.Before(r.closeDeadline) {
			r.closeDeadline = a.cleanupDeadline
		}
	}
	if r.reading {
		a.mu.Unlock()
		return errPLDebugAllocationUnknown
	}
	if !r.call.finished {
		r.call.finished = true
		close(r.call.done)
		a.completeCallLocked(r.call)
	}
	if a.active != nil || a.unknown {
		a.mu.Unlock()
		return errPLDebugAllocationUnknown
	}
	if !r.closeStarted {
		r.closeStarted = true
		go r.closeRaw()
	}
	done, deadline := r.closeDone, r.closeDeadline
	a.mu.Unlock()
	select {
	case <-done:
		return r.result()
	default:
	}
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case <-done:
		return r.result()
	case <-timer.C:
		return errPLDebugAllocationUnknown
	}
}

func (r *plDebugRows) result() error {
	r.allocation.mu.Lock()
	defer r.allocation.mu.Unlock()
	return r.closeErr
}

func (r *plDebugRows) closeRaw() {
	var err error
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("PL/SQL rows close panicked: %v", recovered)
		}
		a := r.allocation
		a.mu.Lock()
		r.closeErr = err
		if err != nil {
			a.unknown = true
		} else {
			delete(a.rows, r)
		}
		a.closingRows--
		close(r.closeDone)
		a.resumeReferencesLocked()
		retiring := a.retiring && !a.unknown && len(a.rows) == 0 && len(a.statements) == 0
		a.mu.Unlock()
		if retiring {
			_ = a.close()
		}
	}()
	err = r.Rows.Close()
}

func (r *plDebugRows) ColumnTypeDatabaseTypeName(i int) string {
	if rows, ok := r.Rows.(driver.RowsColumnTypeDatabaseTypeName); ok {
		return rows.ColumnTypeDatabaseTypeName(i)
	}
	return ""
}
func (r *plDebugRows) ColumnTypeLength(i int) (int64, bool) {
	if rows, ok := r.Rows.(driver.RowsColumnTypeLength); ok {
		return rows.ColumnTypeLength(i)
	}
	return 0, false
}
func (r *plDebugRows) ColumnTypeNullable(i int) (bool, bool) {
	if rows, ok := r.Rows.(driver.RowsColumnTypeNullable); ok {
		return rows.ColumnTypeNullable(i)
	}
	return false, false
}
func (r *plDebugRows) ColumnTypePrecisionScale(i int) (int64, int64, bool) {
	if rows, ok := r.Rows.(driver.RowsColumnTypePrecisionScale); ok {
		return rows.ColumnTypePrecisionScale(i)
	}
	return 0, 0, false
}
func (r *plDebugRows) ColumnTypeScanType(i int) reflect.Type {
	if rows, ok := r.Rows.(driver.RowsColumnTypeScanType); ok {
		return rows.ColumnTypeScanType(i)
	}
	return reflect.TypeOf((*interface{})(nil)).Elem()
}
func (r *plDebugRows) HasNextResultSet() bool {
	if rows, ok := r.Rows.(driver.RowsNextResultSet); ok {
		return rows.HasNextResultSet()
	}
	return false
}
func (r *plDebugRows) NextResultSet() error {
	if rows, ok := r.Rows.(driver.RowsNextResultSet); ok {
		return r.read(rows.NextResultSet)
	}
	return io.EOF
}
