package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
)

type plDebugCaptureTestConnector struct {
	tx          plDebugTransactionTestConnector
	output      string
	code        int64
	message     string
	rollback    int64
	nativeError string
	complete    int64
	truncated   int64
	stmtCloses  int
	closeCheck  func() error
	input       interface{}
}

func (c *plDebugCaptureTestConnector) Driver() driver.Driver { return c.tx.Driver() }
func (c *plDebugCaptureTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.tx.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugCaptureTestConnection{plDebugTransactionTestConnection: conn.(*plDebugTransactionTestConnection), state: c}, nil
}

type plDebugCaptureTestConnection struct {
	*plDebugTransactionTestConnection
	state *plDebugCaptureTestConnector
}

func (c *plDebugCaptureTestConnection) PrepareContext(context.Context, string) (driver.Stmt, error) {
	return &plDebugCaptureTestStatement{state: c.state}, nil
}
func (c *plDebugCaptureTestConnection) Prepare(string) (driver.Stmt, error) {
	return &plDebugCaptureTestStatement{state: c.state}, nil
}

type plDebugCaptureTestStatement struct{ state *plDebugCaptureTestConnector }

func (*plDebugCaptureTestStatement) NumInput() int { return -1 }
func (*plDebugCaptureTestStatement) CheckNamedValue(value *driver.NamedValue) error {
	return plDebugAcceptTestStatementValue(value)
}
func (s *plDebugCaptureTestStatement) Close() error {
	if s.state.closeCheck != nil {
		if err := s.state.closeCheck(); err != nil {
			return err
		}
	}
	s.state.stmtCloses++
	return nil
}
func (s *plDebugCaptureTestStatement) Exec([]driver.Value) (driver.Result, error) {
	return nil, errors.New("use context execution")
}
func (*plDebugCaptureTestStatement) Query([]driver.Value) (driver.Rows, error) {
	return nil, errors.New("unexpected query")
}
func (s *plDebugCaptureTestStatement) ExecContext(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
	c := s.state
	if !c.tx.active {
		return nil, errors.New("target wrapper escaped its original transaction")
	}
	c.tx.base.execs++
	if len(args) < 7 {
		return nil, errors.New("capture OUT registers missing")
	}
	if len(args) > 7 {
		c.input = args[0].Value
	}
	for i, arg := range args[len(args)-7:] {
		var dest interface{}
		switch value := arg.Value.(type) {
		case go_ora.Out:
			dest = value.Dest
		case sql.Out:
			dest = value.Dest
		default:
			return nil, errors.New("capture must use OUT binding")
		}
		switch value := dest.(type) {
		case *sql.NullInt64:
			v := c.code
			switch i {
			case 2:
				v = c.rollback
			case 5:
				v = c.truncated
			case 6:
				v = c.complete
			}
			*value = sql.NullInt64{Int64: v, Valid: true}
		case *sql.NullString:
			v := c.message
			if i == 4 {
				v = c.nativeError
			}
			*value = sql.NullString{String: v, Valid: v != ""}
		case *go_ora.Clob:
			*value = go_ora.Clob{String: c.output, Valid: true}
		default:
			return nil, errors.New("unexpected capture destination")
		}
	}
	return driver.RowsAffected(0), nil
}

func openNativeCaptureTest(t *testing.T, c *plDebugCaptureTestConnector, profile string) (*runtimeServer, *server, *sql.Tx) {
	t.Helper()
	r := plDebugPairTestRuntime(&plDebugConnectTestConnector{}, c)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a","driver_profile":"` + profile + `"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s, _ := r.session("a")
	tx, err := s.server.beginNativeDebuggeeTransaction()
	if err != nil {
		t.Fatal(err)
	}
	return r, s.server, tx
}

func TestPLDebugNativeCapturePreservesWholeSourceAndLargeThinCLOB(t *testing.T) {
	source := "\n  BEGIN\n    SYS.DBMS_OUTPUT.PUT_LINE('$OUTPUT, DBX marker');\n    SYS.DBMS_OUTPUT.PUT_LINE(:1);\n  END;\n/\n"
	block, err := plDebugWrapNativeTarget(source, 1)
	if err != nil {
		t.Fatal(err)
	}
	body := strings.TrimSuffix(source, "/\n")
	lines := strings.Split(block.SQL, "\n")
	if strings.Join(lines[block.SourceLineOffset:block.SourceLineOffset+block.SourceLineCount], "\n") != body {
		t.Fatal("wrapper changed source bytes or line alignment")
	}
	for _, name := range block.PrivateNames {
		if len(name) > 30 {
			t.Fatal("private identifier exceeded legacy Oracle limits")
		}
	}
	text := strings.Repeat("中文😀\n", 10000) + "\n" + strings.Repeat("x", 32767) + "\n"
	c := &plDebugCaptureTestConnector{output: text, rollback: -1, complete: 1}
	r, s, tx := openNativeCaptureTest(t, c, "thin")
	input := "bound ' value; -- 😀"
	capture, err := plDebugExecuteNativeCapture(context.Background(), tx, s.plDebuggeeAllocation, false, block, []interface{}{input})
	if err != nil {
		t.Fatal(err)
	}
	if capture.Output != text || !capture.OutputComplete || capture.ReferencesPending || capture.Code.Int64 != 0 || c.input != input || c.stmtCloses != 1 || c.tx.base.execs != 1 {
		t.Fatalf("capture lost source/output/execution facts: %+v", capture)
	}
	resp, _ := r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil || c.tx.rollbacks != 1 {
		t.Fatalf("original transaction did not retire: %+v", resp)
	}
}

func TestPLDebugNativeCaptureOutputFailureDoesNotReplaceBusinessFacts(t *testing.T) {
	block, err := plDebugWrapNativeTarget("BEGIN NULL; END;", 0)
	if err != nil {
		t.Fatal(err)
	}
	c := &plDebugCaptureTestConnector{code: -20001, message: "business exception", rollback: 1, nativeError: "native output partial", complete: 0}
	r, s, tx := openNativeCaptureTest(t, c, "thin")
	reads, releases := 0, 0
	var value go_ora.Clob
	clob := &plDebugClobOutput{bind: go_ora.Out{Dest: &value}, read: func() (string, error) { reads++; return "partial 😀\n", errors.New("transfer failed") }, release: func() error { releases++; return nil }}
	c.closeCheck = func() error {
		if releases != 1 {
			return errors.New("statement closed before locator release")
		}
		return nil
	}
	capture, err := plDebugExecuteBoundCapture(context.Background(), tx, s.plDebuggeeAllocation, false, block, nil, clob)
	if err != nil || capture.Code.Int64 != -20001 || capture.SavepointRollback.Int64 != 1 || capture.Output != "partial 😀\n" || capture.OutputComplete || !strings.Contains(capture.OutputError, "transfer failed") || capture.ReferencesPending {
		t.Fatalf("independent outcomes were overwritten: %+v %v", capture, err)
	}
	capture.finishReferences(context.Background(), s.plDebuggeeAllocation)
	if reads != 1 || releases != 1 || c.stmtCloses != 1 || c.tx.base.execs != 1 {
		t.Fatal("capture cleanup reread or replayed the target")
	}
	resp, _ := r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
}

func TestPLDebugNativeCaptureReleaseFailureKeepsStatementAndOriginalOwner(t *testing.T) {
	block, err := plDebugWrapNativeTarget("BEGIN NULL; END;", 0)
	if err != nil {
		t.Fatal(err)
	}
	c := &plDebugCaptureTestConnector{complete: 1, rollback: -1}
	r, s, tx := openNativeCaptureTest(t, c, "thin")
	var value go_ora.Clob
	releases := 0
	clob := &plDebugClobOutput{bind: go_ora.Out{Dest: &value}, read: func() (string, error) { return "complete\n", nil }, release: func() error { releases++; return errors.New("locator release unconfirmed") }}
	capture, err := plDebugExecuteBoundCapture(context.Background(), tx, s.plDebuggeeAllocation, false, block, nil, clob)
	if err != nil || !capture.OutputComplete || capture.ReleaseError == "" || !capture.ReferencesPending || c.stmtCloses != 0 {
		t.Fatalf("release failure lost independent facts: %+v %v", capture, err)
	}
	capture.finishReferences(context.Background(), s.plDebuggeeAllocation)
	resp, _ := r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || releases != 1 || c.stmtCloses != 0 || c.tx.rollbacks != 0 || c.tx.base.closes != 0 || len(r.sessions) != 1 {
		t.Fatal("unconfirmed locator release was retried or closed over")
	}
}

func TestPLDebugNativeCaptureKeepsLocatorAndStatementAcrossPendingBreak(t *testing.T) {
	block, err := plDebugWrapNativeTarget("BEGIN NULL; END;", 0)
	if err != nil {
		t.Fatal(err)
	}
	c := &plDebugCaptureTestConnector{complete: 1, rollback: -1, tx: plDebugTransactionTestConnector{base: plDebugConnectTestConnector{breakStarted: make(chan struct{}), breakRelease: make(chan struct{})}}}
	r, s, tx := openNativeCaptureTest(t, c, "oci")
	readStarted, readRelease := make(chan struct{}), make(chan struct{})
	var releaseRead, releaseBreak sync.Once
	defer releaseRead.Do(func() { close(readRelease) })
	defer releaseBreak.Do(func() { close(c.tx.base.breakRelease) })
	reads, releases := 0, 0
	var value go_ora.Clob
	clob := &plDebugClobOutput{bind: sql.Out{Dest: &value}, read: func() (string, error) { reads++; close(readStarted); <-readRelease; return "full 😀\n", nil }, release: func() error { releases++; return nil }}
	c.closeCheck = func() error {
		if releases != 1 {
			return errors.New("statement closed before locator")
		}
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan plDebugNativeCapture, 1)
	go func() {
		capture, _ := plDebugExecuteBoundCapture(ctx, tx, s.plDebuggeeAllocation, true, block, nil, clob)
		done <- capture
	}()
	select {
	case <-readStarted:
	case <-time.After(time.Second):
		t.Fatal("LOB read did not start")
	}
	cancel()
	select {
	case <-c.tx.base.breakStarted:
	case <-time.After(time.Second):
		t.Fatal("LOB cancellation did not reach original Break")
	}
	releaseRead.Do(func() { close(readRelease) })
	var capture plDebugNativeCapture
	select {
	case capture = <-done:
	case <-time.After(time.Second):
		t.Fatal("capture did not preserve the completed target result")
	}
	if !capture.OutputComplete || capture.Output != "full 😀\n" || !capture.ReferencesPending || releases != 0 || c.stmtCloses != 0 {
		t.Fatalf("pending Break lost output or references: %+v", capture)
	}
	resp, _ := r.handleLine(`{"id":2,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error == nil || c.tx.rollbacks != 0 {
		t.Fatal("cleanup passed a pending locator reference")
	}
	a := s.plDebuggeeAllocation
	a.mu.Lock()
	call := a.active
	a.mu.Unlock()
	if call == nil {
		t.Fatal("pending Break responsibility was forgotten")
	}
	releaseBreak.Do(func() { close(c.tx.base.breakRelease) })
	select {
	case <-call.cancelDone:
	case <-time.After(time.Second):
		t.Fatal("Break did not drain")
	}
	cleanupCtx, cleanupCancel := context.WithDeadline(context.Background(), s.plCleanupDeadline)
	defer cleanupCancel()
	capture.finishReferences(cleanupCtx, a)
	if capture.ReferencesPending || capture.ReleaseError != "" || reads != 1 || releases != 1 || c.stmtCloses != 1 || c.tx.base.execs != 1 {
		t.Fatalf("original cleanup reread, replayed or lost references: %+v", capture)
	}
	resp, _ = r.handleLine(`{"id":3,"method":"close_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
}

func TestPLDebugNativeCleanupAndCachedUTF16Pages(t *testing.T) {
	block, err := plDebugNativeCleanupBlock()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(block.SQL, "SAVEPOINT ") || strings.Contains(block.SQL, "ROLLBACK TO ") || !strings.Contains(block.SQL, "SYS.DBMS_OUTPUT.GET_LINE") {
		t.Fatal("private cleanup contains transaction or target work")
	}
	capture := plDebugNativeCapture{Output: "A😀中\n\n", OutputComplete: true}
	first, err := capture.page(0, 2)
	if err != nil || first.Text != "A" || first.NextOffset != 1 || first.TotalChars != 6 {
		t.Fatalf("first UTF16 page: %+v %v", first, err)
	}
	second, err := capture.page(1, 2)
	if err != nil || second.Text != "😀" || second.NextOffset != 3 {
		t.Fatalf("second UTF16 page: %+v %v", second, err)
	}
	again, err := capture.page(1, 2)
	if err != nil || again != second {
		t.Fatal("cached pagination changed or consumed output")
	}
	if _, err := capture.page(2, 2); err == nil {
		t.Fatal("cursor split a surrogate pair")
	}
	if _, err := capture.page(0, 1); err == nil {
		t.Fatal("page size cannot fit a Unicode character")
	}
	if got := plDebugOutputPrefix("中😀x", 5); got != "中" {
		t.Fatalf("byte limit split a Unicode character: %q", got)
	}
}
