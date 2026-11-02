package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func (c *plDebugConnectTestConnection) Break() error {
	c.connector.mu.Lock()
	c.connector.breaks++
	c.connector.mu.Unlock()
	if c.connector.breakStarted != nil {
		close(c.connector.breakStarted)
	}
	if c.connector.breakRelease != nil {
		<-c.connector.breakRelease
	}
	return c.connector.breakErr
}

func TestPLDebugOCICancelWaitsForTargetAndBreak(t *testing.T) {
	for _, order := range []string{"target-first", "break-first", "break-failed"} {
		t.Run(order, func(t *testing.T) {
			c := &plDebugConnectTestConnector{execStarted: make(chan struct{}), execRelease: make(chan struct{}), breakStarted: make(chan struct{}), breakRelease: make(chan struct{}), closeStarted: make(chan struct{})}
			if order == "break-failed" {
				c.breakErr = errors.New("Break failed")
			}
			var releaseTarget, releaseBreak sync.Once
			defer releaseTarget.Do(func() { close(c.execRelease) })
			defer releaseBreak.Do(func() { close(c.breakRelease) })
			r := plDebugConnectTestRuntime(c)
			resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a","driver_profile":"oci"}}`)
			if resp.Error != nil {
				t.Fatal(resp.Error)
			}
			s, _ := r.session("a")
			a := s.server.plAllocation
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { _, err := s.server.plConnection.ExecContext(ctx, "BEGIN NULL; END;"); done <- err }()
			select {
			case <-c.execStarted:
			case <-time.After(time.Second):
				t.Fatal("target did not start")
			}
			a.mu.Lock()
			call := a.active
			a.mu.Unlock()
			cancel()
			select {
			case <-c.breakStarted:
			case <-time.After(time.Second):
				t.Fatal("synchronous Break was not dispatched")
			}
			if order == "break-first" {
				releaseBreak.Do(func() { close(c.breakRelease) })
				select {
				case <-call.cancelDone:
				case <-time.After(time.Second):
					t.Fatal("Break did not complete")
				}
				select {
				case <-c.closeStarted:
					t.Fatal("Break completion closed an executing target")
				default:
				}
				a.mu.Lock()
				active := a.active == call
				a.mu.Unlock()
				if !active {
					t.Fatal("Break completion admitted another call before the target returned")
				}
			}
			releaseTarget.Do(func() { close(c.execRelease) })
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("natural target success was replaced by cancellation: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("target did not return")
			}
			if order != "break-first" {
				if _, err := s.server.plConnection.ExecContext(context.Background(), "BEGIN NULL; END;"); err == nil {
					t.Fatal("next call passed a pending Break")
				}
				a.cancelCall(call)
				releaseBreak.Do(func() { close(c.breakRelease) })
				select {
				case <-call.cancelDone:
				case <-time.After(time.Second):
					t.Fatal("Break did not drain")
				}
			}
			if c.breaks != 1 {
				t.Fatalf("duplicate cancellation: %d", c.breaks)
			}
			if order == "break-failed" {
				resp, _ = r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
				if resp.Error == nil || len(r.sessions) != 1 {
					t.Fatal("failed Break forgot the original unknown allocation")
				}
				select {
				case <-c.closeStarted:
					t.Fatal("failed Break allowed raw Close")
				default:
				}
				return
			}
			c.execStarted = nil
			c.execRelease = nil
			if _, err := s.server.plConnection.ExecContext(context.Background(), "BEGIN NULL; END;"); err != nil {
				t.Fatalf("drained original owner could not continue: %v", err)
			}
			resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
			if resp.Error != nil || c.closes != 1 || c.execs != 2 {
				t.Fatalf("original owner did not finish: %+v exec=%d close=%d", resp, c.execs, c.closes)
			}
		})
	}
}
