package main

import (
	"context"
	"database/sql/driver"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestPLDebugThinCancellationCannotEnterTerminalLogoff(t *testing.T) {
	raw := &plDebugTerminalTestConnection{}
	allocation := &plDebugAllocation{raw: &oracleQueryConnection{oracleThinConnection: raw}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var released sync.Once
	defer released.Do(func() { close(release) })
	go func() {
		_, _ = allocation.exec(ctx, func(context.Context) (driver.Result, error) { close(started); <-release; return nil, nil })
		close(finished)
	}()
	<-started
	allocation.mu.Lock()
	call := allocation.active
	allocation.mu.Unlock()
	cancel()
	<-call.cancelDone
	if err := allocation.close(); !errors.Is(err, errPLDebugAllocationUnknown) {
		t.Fatal("thin cancellation watcher was treated as a release receipt")
	}
	released.Do(func() { close(release) })
	<-finished
	if err := allocation.close(); !errors.Is(err, errPLDebugAllocationUnknown) {
		t.Fatal("thin cancellation uncertainty disappeared after the query returned")
	}
	if raw.logoffs != 0 || raw.closes != 0 {
		t.Fatal("terminal protocol crossed the original cancellation barrier")
	}
}

type plDebugTerminalTestConnection struct {
	oracleThinConnection
	mu                                                       sync.Mutex
	logoffs, closes                                          int
	logoffErr, closeErr                                      error
	logoffStarted, logoffRelease, closeStarted, closeRelease chan struct{}
	panicLogoff                                              bool
}

func (c *plDebugTerminalTestConnection) Logoff() error {
	c.mu.Lock()
	c.logoffs++
	c.mu.Unlock()
	if c.logoffStarted != nil {
		close(c.logoffStarted)
		<-c.logoffRelease
	}
	if c.panicLogoff {
		panic("test logoff failure")
	}
	return c.logoffErr
}
func (c *plDebugTerminalTestConnection) Close() error {
	c.mu.Lock()
	c.closes++
	c.mu.Unlock()
	if c.closeStarted != nil {
		close(c.closeStarted)
		<-c.closeRelease
	}
	return c.closeErr
}

func TestPLDebugThinTerminalCloseKeepsBothReceipts(t *testing.T) {
	logoffFailure, closeFailure := errors.New("logoff failure"), errors.New("close failure")
	for _, test := range []struct {
		name                string
		logoffErr, closeErr error
		oci, panicLogoff    bool
	}{
		{"success", nil, nil, false, false},
		{"logoff-error", logoffFailure, nil, false, false},
		{"close-error", nil, closeFailure, false, false},
		{"both-errors", logoffFailure, closeFailure, false, false},
		{"logoff-panic", nil, nil, false, true},
		{"oci-unchanged", nil, nil, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw := &plDebugTerminalTestConnection{logoffErr: test.logoffErr, closeErr: test.closeErr, panicLogoff: test.panicLogoff}
			allocation := &plDebugAllocation{raw: &oracleQueryConnection{oracleThinConnection: raw}, oci: test.oci}
			err := allocation.close()
			wantError := test.logoffErr != nil || test.closeErr != nil || test.panicLogoff
			if (err != nil) != wantError {
				t.Fatalf("wrong composite receipt: %v", err)
			}
			if test.logoffErr != nil && !errors.Is(err, test.logoffErr) || test.closeErr != nil && !errors.Is(err, test.closeErr) {
				t.Fatal("one terminal error was overwritten")
			}
			if allocation.logoffRequired != !test.oci || allocation.logoffConfirmed != (!test.oci && test.logoffErr == nil && !test.panicLogoff) || allocation.rawCloseConfirmed != (test.closeErr == nil) || allocation.closed == wantError {
				t.Fatal("independent terminal facts were conflated")
			}
			if again := allocation.close(); (again != nil) != wantError {
				t.Fatal("repeated close lost its original receipt")
			}
			wantLogoffs := 1
			if test.oci {
				wantLogoffs = 0
			}
			if raw.logoffs != wantLogoffs || raw.closes != 1 {
				t.Fatal("terminal operation was retried")
			}
		})
	}
}

func TestPLDebugThinTerminalCloseTimeoutOnlyStopsWaiting(t *testing.T) {
	raw := &plDebugTerminalTestConnection{logoffStarted: make(chan struct{}), logoffRelease: make(chan struct{}), closeStarted: make(chan struct{}), closeRelease: make(chan struct{})}
	allocation := &plDebugAllocation{raw: &oracleQueryConnection{oracleThinConnection: raw}, cleanupDeadline: time.Now().Add(30 * time.Millisecond)}
	var releaseLogoff, releaseClose sync.Once
	defer releaseLogoff.Do(func() { close(raw.logoffRelease) })
	defer releaseClose.Do(func() { close(raw.closeRelease) })
	if err := allocation.close(); !errors.Is(err, errPLDebugAllocationUnknown) {
		t.Fatal("blocked Logoff was reported released")
	}
	<-raw.logoffStarted
	releaseLogoff.Do(func() { close(raw.logoffRelease) })
	select {
	case <-raw.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("original close did not follow Logoff")
	}
	allocation.mu.Lock()
	confirmed, closed := allocation.logoffConfirmed, allocation.closed
	done := allocation.closeDone
	allocation.mu.Unlock()
	if !confirmed || closed {
		t.Fatal("Logoff acknowledgement and physical close were conflated")
	}
	if err := allocation.close(); !errors.Is(err, errPLDebugAllocationUnknown) {
		t.Fatal("repeat wait granted a new close budget")
	}
	releaseClose.Do(func() { close(raw.closeRelease) })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("late original close did not settle")
	}
	if err := allocation.close(); err != nil {
		t.Fatal(err)
	}
	if raw.logoffs != 1 || raw.closes != 1 {
		t.Fatal("late closure was restarted")
	}
}
