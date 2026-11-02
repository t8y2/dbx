package main

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
)

func TestPLDebugLobOutputIndependentReceipts(t *testing.T) {
	for _, sample := range []struct {
		receipt, length int64
		text, state     string
	}{
		{1, -1, "", "null"}, {2, 0, "", "value"}, {3, 5, "中文🙂\x00", "value"},
		{4, 0, "", "partial"}, {4, 5, "中文🙂\x00", "partial"},
		{5, 5, "中文🙂\x00", "partial"},
		{3, 4, "中文🙂\x00", "error"}, {2, 1, "", "error"}, {-1, -2, "", "error"},
	} {
		receipt, length := sql.NullInt64{Int64: sample.receipt, Valid: true}, sql.NullInt64{Int64: sample.length, Valid: true}
		lob, err := newPLDebugLobOutput(false, false, &receipt, &length)
		if err != nil {
			t.Fatal(err)
		}
		*lob.bind.(go_ora.Out).Dest.(*go_ora.Clob) = go_ora.Clob{String: sample.text, Valid: sample.text != ""}
		lob.collect(context.Background(), nil, 100)
		if lob.state != sample.state {
			t.Fatalf("receipt %d/%d: got %s", sample.receipt, sample.length, lob.state)
		}
		if sample.receipt == 5 && lob.sourceError != "export_incomplete" {
			t.Fatal("server export error was mislabeled as a reader failure")
		}
		lob.finish(context.Background(), nil)
		if !lob.released {
			t.Fatal("thin deferred-to-session resource blocked statement retirement")
		}
	}
}

func TestPLDebugCaptureOwnsAllTypedLobsUntilReadAndRelease(t *testing.T) {
	for _, failRead := range []bool{false, true} {
		c := &plDebugCaptureTestConnector{complete: 1, rollback: -1}
		r, s, tx := openNativeCaptureTest(t, c, "thin")
		reads, releases := 0, 0
		receipt, length := sql.NullInt64{Int64: 3, Valid: true}, sql.NullInt64{Int64: 1, Valid: true}
		lob := &plDebugLobOutput{receipt: &receipt, length: &length, state: "unavailable", read: func(int) ([]byte, error) {
			reads++
			if failRead {
				return nil, errors.New("read failed")
			}
			return []byte("x"), nil
		}, release: func() error { releases++; return nil }}
		c.closeCheck = func() error {
			if reads != 1 || releases != 1 {
				return errors.New("statement closed over typed LOB reference")
			}
			return nil
		}
		block, err := plDebugWrapNativeTarget("BEGIN NULL; END;", 0)
		if err != nil {
			t.Fatal(err)
		}
		capture, err := plDebugExecuteObservedCapture(context.Background(), tx, s.plDebuggeeAllocation, false, block, nil, &plDebugCaptureObserver{lobs: []*plDebugLobOutput{lob}})
		if err != nil || capture.ReferencesPending || c.stmtCloses != 1 || !lob.released || reads != 1 || releases != 1 {
			t.Fatalf("typed LOB retirement incomplete: %+v %v", capture, err)
		}
		if failRead && lob.state != "error" || !failRead && lob.state != "value" {
			t.Fatal("field read outcome was lost")
		}
		capture.finishReferences(context.Background(), s.plDebuggeeAllocation)
		if reads != 1 || releases != 1 {
			t.Fatal("typed LOB reread or release repeated")
		}
		resp, _ := r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
		if resp.Error != nil {
			t.Fatal(resp.Error)
		}
	}
}

func TestPLDebugTypedLobReleaseFailureRetainsOriginalStatement(t *testing.T) {
	c := &plDebugCaptureTestConnector{complete: 1, rollback: -1}
	r, s, tx := openNativeCaptureTest(t, c, "thin")
	receipt, length := sql.NullInt64{Int64: 3, Valid: true}, sql.NullInt64{Int64: 1, Valid: true}
	releases := 0
	lob := &plDebugLobOutput{receipt: &receipt, length: &length, state: "unavailable", read: func(int) ([]byte, error) { return []byte("x"), nil }, release: func() error { releases++; return errors.New("release not confirmed") }}
	block, err := plDebugWrapNativeTarget("BEGIN NULL; END;", 0)
	if err != nil {
		t.Fatal(err)
	}
	capture, err := plDebugExecuteObservedCapture(context.Background(), tx, s.plDebuggeeAllocation, false, block, nil, &plDebugCaptureObserver{lobs: []*plDebugLobOutput{lob}})
	if err != nil || !capture.ReferencesPending || capture.ReleaseError == "" || c.stmtCloses != 0 || lob.state != "value" {
		t.Fatal("release failure discarded copied value or original statement")
	}
	capture.finishReferences(context.Background(), s.plDebuggeeAllocation)
	resp, _ := r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || releases != 1 || c.stmtCloses != 0 || c.tx.rollbacks != 0 || c.tx.base.closes != 0 {
		t.Fatal("release uncertainty was retried or closed over")
	}
}

func TestPLDebugLobReadFailurePreservesOnlyCompletePrefix(t *testing.T) {
	for _, sample := range []struct {
		data   []byte
		binary bool
		want   string
	}{
		{[]byte("A🙂\xe4\xb8"), false, "A🙂"},
		{[]byte("A🙂"), false, "A🙂"},
		{[]byte{0, 255, 128}, true, string([]byte{0, 255, 128})},
	} {
		receipt, length := sql.NullInt64{Int64: 3, Valid: true}, sql.NullInt64{Int64: 100, Valid: true}
		lob := &plDebugLobOutput{receipt: &receipt, length: &length, memory: true, binary: sample.binary, read: func(int) ([]byte, error) { return sample.data, errors.New("interrupted read") }, release: func() error { return nil }}
		lob.collect(context.Background(), nil, 100)
		if lob.state != "partial" || string(lob.data) != sample.want || lob.err == nil {
			t.Fatal("read failure lost prefix or retained an incomplete UTF8 character")
		}
		cache := plDebugResultCache{}
		manifest, err := cache.retainWithState(lob.data, lob.binary, "X", false, "read_failed")
		if err != nil || manifest["complete"] != false || manifest["truncated"] != false || manifest["error"] != "read_failed" {
			t.Fatal("read failure was relabeled as complete or budget truncation")
		}
	}
}

func TestPLDebugThinLobBudgetPreservesUnicodePrefix(t *testing.T) {
	receipt, length := sql.NullInt64{Int64: 3, Valid: true}, sql.NullInt64{Int64: 4, Valid: true}
	lob, err := newPLDebugLobOutput(false, false, &receipt, &length)
	if err != nil {
		t.Fatal(err)
	}
	*lob.bind.(go_ora.Out).Dest.(*go_ora.Clob) = go_ora.Clob{String: "A🙂B", Valid: true}
	lob.collect(context.Background(), nil, 3)
	if lob.state != "partial" || string(lob.data) != "A" || !errors.Is(lob.err, errPLDebugLobBudget) {
		t.Fatal("budget truncation discarded prefix or split Unicode")
	}
}

func TestPLDebugTypedLobPendingBreakKeepsOriginalReferences(t *testing.T) {
	c := &plDebugCaptureTestConnector{complete: 1, rollback: -1, tx: plDebugTransactionTestConnector{base: plDebugConnectTestConnector{breakStarted: make(chan struct{}), breakRelease: make(chan struct{})}}}
	r, s, tx := openNativeCaptureTest(t, c, "oci")
	readStarted, readRelease := make(chan struct{}), make(chan struct{})
	var releaseRead, releaseBreak sync.Once
	defer releaseRead.Do(func() { close(readRelease) })
	defer releaseBreak.Do(func() { close(c.tx.base.breakRelease) })
	reads, releases := 0, 0
	receipt, length := sql.NullInt64{Int64: 3, Valid: true}, sql.NullInt64{Int64: 1, Valid: true}
	lob := &plDebugLobOutput{receipt: &receipt, length: &length, state: "unavailable", read: func(int) ([]byte, error) { reads++; close(readStarted); <-readRelease; return []byte("x"), nil }, release: func() error { releases++; return nil }}
	var output go_ora.Clob
	clob := &plDebugClobOutput{bind: sql.Out{Dest: &output}, memory: true, read: func() (string, error) { return "", nil }, release: func() error { return nil }}
	c.closeCheck = func() error {
		if releases != 1 {
			return errors.New("statement closed before typed locator release")
		}
		return nil
	}
	block, err := plDebugWrapNativeTarget("BEGIN NULL; END;", 0)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan plDebugNativeCapture, 1)
	go func() {
		capture, _ := plDebugExecuteCaptureWith(ctx, tx, s.plDebuggeeAllocation, true, block, nil, clob, &plDebugCaptureObserver{lobs: []*plDebugLobOutput{lob}})
		done <- capture
	}()
	select {
	case <-readStarted:
	case <-time.After(time.Second):
		t.Fatal("typed LOB read did not start")
	}
	cancel()
	select {
	case <-c.tx.base.breakStarted:
	case <-time.After(time.Second):
		t.Fatal("typed LOB cancellation did not reach original Break")
	}
	releaseRead.Do(func() { close(readRelease) })
	var capture plDebugNativeCapture
	select {
	case capture = <-done:
	case <-time.After(time.Second):
		t.Fatal("typed read result did not return")
	}
	if !capture.ReferencesPending || lob.state != "value" || releases != 0 || c.stmtCloses != 0 {
		t.Fatal("pending Break lost copied value or retired original references")
	}
	resp, _ := r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || c.tx.rollbacks != 0 {
		t.Fatal("transaction cleanup passed pending typed LOB references")
	}
	a := s.plDebuggeeAllocation
	a.mu.Lock()
	call := a.active
	a.mu.Unlock()
	if call == nil {
		t.Fatal("original cancellation owner lost")
	}
	releaseBreak.Do(func() { close(c.tx.base.breakRelease) })
	select {
	case <-call.cancelDone:
	case <-time.After(time.Second):
		t.Fatal("original Break did not drain")
	}
	cleanup, stop := context.WithDeadline(context.Background(), s.plCleanupDeadline)
	defer stop()
	capture.finishReferences(cleanup, a)
	if capture.ReferencesPending || reads != 1 || releases != 1 || c.stmtCloses != 1 {
		t.Fatal("typed references did not resume once after original Break acknowledgement")
	}
	resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
}
