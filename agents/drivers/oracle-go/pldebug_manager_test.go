package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
)

type plDebugManagerTestEngine struct {
	mu                   sync.Mutex
	targetStarted        chan struct{}
	targetRelease        chan struct{}
	continueStarted      chan struct{}
	continueRelease      chan struct{}
	prepareStarted       chan struct{}
	prepareRelease       chan struct{}
	cleanupStarted       chan struct{}
	cleanupRelease       chan struct{}
	cleanupPhase         bool
	aborted              bool
	targetAttempts       int
	cleanupAttempts      int
	abortStarted         chan struct{}
	abortRelease         chan struct{}
	abortCancelled       chan struct{}
	panicControl         bool
	holdTargetOnContinue bool
	release              sync.Once
	controls             int
	queries              []string
	targetBlock          string
}

type plDebugManagerTestConnector struct {
	base            plDebugCaptureTestConnector
	engine          *plDebugManagerTestEngine
	breakController bool
	breakTarget     bool
}

func (c *plDebugManagerTestConnector) Driver() driver.Driver { return c.base.Driver() }
func (c *plDebugManagerTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.base.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugManagerTestConnection{plDebugCaptureTestConnection: conn.(*plDebugCaptureTestConnection), owner: c}, nil
}

type plDebugManagerTestConnection struct {
	*plDebugCaptureTestConnection
	owner *plDebugManagerTestConnector
}

func (c *plDebugManagerTestConnection) Break() error {
	if c.owner.breakController {
		close(c.owner.engine.continueRelease)
	}
	if c.owner.breakTarget {
		c.owner.engine.release.Do(func() { close(c.owner.engine.targetRelease) })
	}
	return c.plDebugCaptureTestConnection.Break()
}

func (*plDebugManagerTestConnection) CheckNamedValue(*driver.NamedValue) error { return nil }

func plDebugManagerSetOut(arg driver.NamedValue, value interface{}) error {
	var dest interface{}
	switch out := arg.Value.(type) {
	case sql.Out:
		dest = out.Dest
	case go_ora.Out:
		dest = out.Dest
	default:
		return errors.New("expected native OUT")
	}
	reflect.ValueOf(dest).Elem().Set(reflect.ValueOf(value))
	return nil
}

func (c *plDebugManagerTestConnection) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	e := c.owner.engine
	e.mu.Lock()
	e.queries = append(e.queries, query)
	e.mu.Unlock()
	integer := func(n int64) sql.NullInt64 { return sql.NullInt64{Int64: n, Valid: true} }
	switch {
	case strings.Contains(query, "SYS.DBMS_DEBUG.INITIALIZE()"):
		return driver.RowsAffected(0), plDebugManagerSetOut(args[0], sql.NullString{String: "native ' id", Valid: true})
	case strings.Contains(query, "SYS.DBMS_DEBUG.SET_TIMEOUT_BEHAVIOUR"):
		if err := plDebugManagerSetOut(args[0], integer(120)); err != nil {
			return nil, err
		}
		return driver.RowsAffected(0), plDebugManagerSetOut(args[2], integer(3))
	case strings.HasPrefix(query, "ALTER SESSION SET CURRENT_SCHEMA"):
		return driver.RowsAffected(0), nil
	case strings.Contains(query, "SYS.DBMS_DEBUG.ATTACH_SESSION(:1)"):
		if args[0].Value != "native ' id" {
			return nil, errors.New("native id was not bound verbatim")
		}
		return driver.RowsAffected(0), nil
	case strings.Contains(query, "SYS.DBMS_DEBUG.SYNCHRONIZE"):
		e.mu.Lock()
		cleanupPhase := e.cleanupPhase
		e.mu.Unlock()
		if cleanupPhase {
			select {
			case <-e.cleanupStarted:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			break
		}
		select {
		case <-e.targetStarted:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	case strings.Contains(query, "SYS.DBMS_DEBUG.CONTINUE"):
		e.mu.Lock()
		e.controls++
		cleanupPhase := e.cleanupPhase
		if strings.Contains(query, "SYS.DBMS_DEBUG.abort_execution") {
			e.aborted = true
		}
		e.mu.Unlock()
		if e.panicControl {
			panic("injected native controller panic")
		}
		if strings.Contains(query, "SYS.DBMS_DEBUG.abort_execution") && e.abortStarted != nil {
			close(e.abortStarted)
			if e.abortCancelled != nil {
				<-ctx.Done()
				close(e.abortCancelled)
			}
			<-e.abortRelease
		}
		if cleanupPhase {
			close(e.cleanupRelease)
			break
		}
		if e.continueStarted != nil {
			close(e.continueStarted)
		}
		if e.continueRelease != nil {
			select {
			case <-e.continueRelease:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if !e.holdTargetOnContinue {
			e.release.Do(func() { close(e.targetRelease) })
		}
	default:
		return nil, errors.New("unexpected SQL; no helper or implicit compilation is allowed")
	}
	terminated := int64(0)
	if strings.Contains(query, "SYS.DBMS_DEBUG.CONTINUE") {
		terminated = 1
	}
	reason := int64(9)
	if strings.Contains(query, "SYS.DBMS_DEBUG.abort_execution") {
		reason = int64(plDebugReasonAborting)
	}
	values := []interface{}{integer(0), integer(21), integer(terminated), sql.NullInt64{}, integer(1), integer(1), integer(reason), integer(0), sql.NullString{String: "raw, run_info.reason = 25\nname", Valid: true}, sql.NullString{String: "Mixed Owner", Valid: true}, sql.NullString{}, integer(21), integer(1), sql.NullString{}}
	for i, arg := range args {
		if err := plDebugManagerSetOut(arg, values[i]); err != nil {
			return nil, err
		}
	}
	return driver.RowsAffected(0), nil
}

func (c *plDebugManagerTestConnection) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	cleanup := !strings.Contains(query, "SAVEPOINT DBX_PD_")
	if !strings.Contains(query, "SYS.DBMS_DEBUG.DEBUG_OFF") {
		return nil, errors.New("unexpected target SQL")
	}
	if !cleanup {
		c.owner.engine.mu.Lock()
		c.owner.engine.targetBlock = query
		c.owner.engine.mu.Unlock()
	}
	if cleanup {
		if strings.Contains(query, "ROLLBACK TO") || strings.Contains(query, "BEGIN NULL; END;") {
			return nil, errors.New("cleanup replayed business source")
		}
		c.owner.engine.mu.Lock()
		c.owner.engine.cleanupPhase = true
		c.owner.engine.mu.Unlock()
		return &plDebugManagerTestStatement{plDebugCaptureTestStatement: &plDebugCaptureTestStatement{state: &c.owner.base}, engine: c.owner.engine, cleanup: true}, nil
	}
	if c.owner.engine.prepareStarted != nil {
		close(c.owner.engine.prepareStarted)
	}
	if c.owner.engine.prepareRelease != nil {
		<-c.owner.engine.prepareRelease
	}
	return &plDebugManagerTestStatement{plDebugCaptureTestStatement: &plDebugCaptureTestStatement{state: &c.owner.base}, engine: c.owner.engine}, nil
}

type plDebugManagerTestStatement struct {
	*plDebugCaptureTestStatement
	engine  *plDebugManagerTestEngine
	cleanup bool
}

func (s *plDebugManagerTestStatement) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	if s.cleanup {
		s.engine.mu.Lock()
		s.engine.cleanupAttempts++
		s.engine.mu.Unlock()
		close(s.engine.cleanupStarted)
		select {
		case <-s.engine.cleanupRelease:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return s.plDebugCaptureTestStatement.ExecContext(ctx, args)
	}
	s.engine.mu.Lock()
	s.engine.targetAttempts++
	s.engine.mu.Unlock()
	close(s.engine.targetStarted)
	select {
	case <-s.engine.targetRelease:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	s.engine.mu.Lock()
	aborted := s.engine.aborted
	s.engine.mu.Unlock()
	if aborted {
		return nil, errors.New("original target aborted")
	}
	return s.plDebugCaptureTestStatement.ExecContext(ctx, args)
}

func plDebugManagerRPC(t *testing.T, r *runtimeServer, method string, params map[string]interface{}) response {
	t.Helper()
	raw, err := json.Marshal(map[string]interface{}{"id": 1, "method": method, "params": params})
	if err != nil {
		t.Fatal(err)
	}
	resp, _ := r.handleLine(string(raw))
	return resp
}

func plDebugManagerSnapshot(t *testing.T, resp response) map[string]interface{} {
	t.Helper()
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	value, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected result: %#v", resp.Result)
	}
	return value
}

func TestPLDebugNativeManagerAnonymousRPCCompletesOriginalPair(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), continueStarted: make(chan struct{}), continueRelease: make(chan struct{})}
	first := &plDebugManagerTestConnector{engine: e}
	second := &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{output: "A😀中\n\n", complete: 1, rollback: -1}}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	start := map[string]interface{}{"agentSessionId": "a", "operationId": "start-1", "objectType": "ANONYMOUS", "schema": "Mixed \"Owner", "source": "BEGIN NULL; END;"}
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", start))
	if state["state"] != "paused" || state["debugId"] != "start-1" || state["nativeDebugId"] != "native ' id" || state["program"] != "raw, run_info.reason = 25\nname" {
		t.Fatalf("native start identity/runtime lost: %#v", state)
	}
	duplicate := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", start))
	if duplicate["stopRevision"] != state["stopRevision"] {
		t.Fatal("duplicate start replaced original stop")
	}
	start["source"] = "BEGIN NULL; NULL; END;"
	if resp := plDebugManagerRPC(t, r, "pl_debug_start", start); resp.Error == nil {
		t.Fatal("changed start reused immutable id")
	}
	continued := make(chan response, 1)
	go func() {
		continued <- plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"agentSessionId": "a", "debugId": "start-1"})
	}()
	select {
	case <-e.continueStarted:
	case <-time.After(time.Second):
		t.Fatal("author resume did not reach native controller")
	}
	for _, method := range []string{"pl_debug_status", "pl_debug_heartbeat", "pl_debug_get_log"} {
		done := make(chan response, 1)
		go func(method string) {
			done <- plDebugManagerRPC(t, r, method, map[string]interface{}{"debugId": "start-1"})
		}(method)
		select {
		case resp := <-done:
			if resp.Error != nil {
				t.Fatal(resp.Error)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s blocked behind CONTINUE", method)
		}
	}
	close(e.continueRelease)
	select {
	case resp := <-continued:
		state = plDebugManagerSnapshot(t, resp)
	case <-time.After(time.Second):
		t.Fatal("resume did not finish")
	}
	if state["state"] != "ended" || state["executionOutcome"] != "succeeded" {
		t.Fatalf("completion facts lost: %#v", state)
	}
	r.mu.RLock()
	entry := r.plNativeEntries["start-1"]
	r.mu.RUnlock()
	select {
	case <-entry.captureDone:
	case <-time.After(time.Second):
		t.Fatal("output transfer did not finish")
	}
	page := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_log", map[string]interface{}{"debugId": "start-1", "offset": 0, "limit": 3}))
	defaultPage := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_log_page", map[string]interface{}{"debugId": "start-1"}))
	if defaultPage["outputPage"] == nil || defaultPage["output"] != nil {
		t.Fatalf("log-page default must return a page: %#v", defaultPage)
	}
	whole := defaultPage["outputPage"].(map[string]interface{})
	if whole["text"] != "A😀中\n\n" || whole["offset"] != 0 || whole["nextOffset"] != 6 || whole["complete"] != true {
		t.Fatalf("default log page lost captured output: %#v", whole)
	}
	if resp := plDebugManagerRPC(t, r, "pl_debug_get_log_page", map[string]interface{}{"debugId": "start-1", "agentSessionId": "foreign"}); resp.Error == nil {
		t.Fatal("log-page alias bypassed original session ownership")
	}
	chunk := page["outputPage"].(map[string]interface{})
	if chunk["text"] != "A😀" || chunk["nextOffset"] != 3 || chunk["totalChars"] != 6 || chunk["complete"] != true {
		t.Fatalf("wrong cached UTF16 page: %#v", page)
	}
	state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "start-1"}))
	if state["releaseState"] != "released" || state["transactionOutcome"] != "rollback_confirmed" || len(r.sessions) != 0 {
		t.Fatalf("close did not release original pair: %#v", state)
	}
	state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_status", map[string]interface{}{"debugId": "start-1"}))
	if state["state"] != "closed" || state["executionOutcome"] != "succeeded" || state["cancelConfirmed"] != false {
		t.Fatal("closing rewrote natural success or lost receipt")
	}
	retained := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_log_page", map[string]interface{}{"debugId": "start-1", "offset": 3, "limit": 3}))
	tail := retained["outputPage"].(map[string]interface{})
	if tail["text"] != "中\n\n" || tail["offset"] != 3 || tail["nextOffset"] != 6 || tail["complete"] != true {
		t.Fatalf("released session lost its cached continuation: %#v", tail)
	}
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "replacement"}); resp.Error == nil {
		t.Fatal("released runtime opened a replacement over its original receipt")
	}
	if first.base.tx.base.connects != 1 || second.base.tx.base.connects != 1 || first.base.tx.base.closes != 1 || second.base.tx.base.closes != 1 || second.base.tx.rollbacks != 1 || second.base.tx.base.execs != 1 || e.controls != 1 {
		t.Fatal("original allocation/target/rollback was replayed")
	}
	e.mu.Lock()
	queries := append([]string{}, e.queries...)
	e.mu.Unlock()
	if !strings.Contains(strings.Join(queries, "\n"), `CURRENT_SCHEMA = "Mixed ""Owner"`) {
		t.Fatal("schema identity changed")
	}
	for _, query := range queries {
		if (strings.Contains(query, "SYS.DBMS_DEBUG.SYNCHRONIZE") || strings.Contains(query, "SYS.DBMS_DEBUG.CONTINUE")) && !strings.Contains(query, "SYS.DBMS_DEBUG.info_getBreakpoint") {
			t.Fatal("native control did not request the breakpoint number it returns")
		}
	}
}

func TestPLDebugNativeManagerPendingStartReceiptDoesNotReplay(t *testing.T) {
	first := &plDebugConnectTestConnector{}
	second := &plDebugConnectTestConnector{started: make(chan struct{}), release: make(chan struct{}), connectErr: errors.New("original connect outcome unknown")}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	start := map[string]interface{}{"agentSessionId": "a", "operationId": "pending-1", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}
	done := make(chan response, 1)
	go func() { done <- plDebugManagerRPC(t, r, "pl_debug_start", start) }()
	select {
	case <-second.started:
	case <-time.After(time.Second):
		t.Fatal("second original connect not started")
	}
	for i := 0; i < 2; i++ {
		state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", start))
		if state["startState"] != "pending" || state["targetDispatched"] != false {
			t.Fatalf("pending receipt missing: %#v", state)
		}
		plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_heartbeat", map[string]interface{}{"operationId": "pending-1"}))
	}
	close(second.release)
	select {
	case resp := <-done:
		state := plDebugManagerSnapshot(t, resp)
		if state["startState"] != "failed" || state["executionOutcome"] != "not_started" {
			t.Fatalf("failure lost original receipt: %#v", state)
		}
	case <-time.After(time.Second):
		t.Fatal("start did not publish failure")
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", start))
	start["operationId"] = "replacement"
	if resp := plDebugManagerRPC(t, r, "pl_debug_start", start); resp.Error == nil {
		t.Fatal("new id replaced unknown original allocation")
	}
	if first.connects != 1 || second.connects != 1 {
		t.Fatal("pending/failed start reconnected")
	}
}

func TestPLDebugNativeBridgeNullFieldsDoNotReuseIdentityOrReasonTermination(t *testing.T) {
	p := &plDebugSession{lastLine: 7, lastProgram: "old", lastProgramOwner: "old", terminated: true}
	p.applyNativeStop(&plDebugNativeStop{Line: sql.NullInt64{Int64: 99}, Reason: sql.NullInt64{Int64: 25, Valid: true}, Program: sql.NullString{String: "stale"}, Terminated: sql.NullInt64{Int64: 1}})
	if p.lastLine != 0 || p.lastProgram != "" || p.lastProgramOwner != "" || p.terminated {
		t.Fatal("NULL native fields preserved stale identity or inferred termination")
	}
}

func TestPLDebugNativeManagerCloseBeforeTargetDispatchKeepsReceipt(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), prepareStarted: make(chan struct{}), prepareRelease: make(chan struct{})}
	first, second := &plDebugManagerTestConnector{engine: e}, &plDebugManagerTestConnector{engine: e}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	start := map[string]interface{}{"agentSessionId": "a", "operationId": "early-close", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}
	started := make(chan response, 1)
	go func() { started <- plDebugManagerRPC(t, r, "pl_debug_start", start) }()
	select {
	case <-e.prepareStarted:
	case <-time.After(time.Second):
		t.Fatal("target prepare did not start")
	}
	closed := make(chan response, 1)
	go func() {
		closed <- plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "early-close"})
	}()
	// The status response is the production admission acknowledgement; no sleeps
	// or private-state writes are needed to order close before target dispatch.
	deadline := time.Now().Add(time.Second)
	for {
		state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_status", map[string]interface{}{"debugId": "early-close"}))
		if state["closeRequested"] == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("close intent was not published")
		}
	}
	close(e.prepareRelease)
	select {
	case resp := <-started:
		plDebugManagerSnapshot(t, resp)
	case <-time.After(time.Second):
		t.Fatal("closed start did not finish")
	}
	select {
	case resp := <-closed:
		state := plDebugManagerSnapshot(t, resp)
		if state["targetDispatched"] != false || state["executionOutcome"] != "not_started" || state["closeRequested"] != true {
			t.Fatalf("close lost dispatch facts: %#v", state)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pre-dispatch close did not finish")
	}
	select {
	case <-e.targetStarted:
		t.Fatal("closed target was dispatched")
	default:
	}
	if second.base.tx.base.execs != 0 || e.controls != 0 {
		t.Fatal("closing before dispatch executed business or continuation SQL")
	}
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", start))
	if state["closeRequested"] != true || second.base.tx.base.connects != 1 {
		t.Fatal("retry replaced the closed original start")
	}
	if resp := plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "early-close"}); resp.Error == nil {
		t.Fatal("late control revived a closed start")
	}
}

func TestPLDebugNativeManagerPausedAbortRecoversOutputWithoutBusinessReplay(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), cleanupStarted: make(chan struct{}), cleanupRelease: make(chan struct{})}
	first := &plDebugManagerTestConnector{engine: e}
	second := &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{output: "before abort😀\n\n", complete: 1}}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	start := map[string]interface{}{"agentSessionId": "a", "operationId": "abort-1", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", start))
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_abort", map[string]interface{}{"debugId": "abort-1"}))
	if state["state"] != "closed" || state["executionOutcome"] != "cancelled" || state["cancelConfirmed"] != true || state["outputComplete"] != true || state["reason"] != plDebugReasonAborting || state["stopRevision"] != int64(1) {
		t.Fatalf("abort/cleanup facts or original stop lost: %#v", state)
	}
	page := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_get_log", map[string]interface{}{"debugId": "abort-1"}))
	if page["output"] != "before abort😀\n\n" {
		t.Fatalf("abort lost original output: %#v", page)
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "abort-1"}))
	if e.targetAttempts != 1 || e.cleanupAttempts != 1 || e.controls != 2 || second.base.tx.rollbacks != 1 || first.base.tx.base.closes != 1 || second.base.tx.base.closes != 1 {
		t.Fatal("private cleanup replayed the target or repeated release")
	}
}

func TestPLDebugNativeManagerCloseDeadlineRetainsOriginalBlockedAbort(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), abortStarted: make(chan struct{}), abortRelease: make(chan struct{}), abortCancelled: make(chan struct{})}
	first, second := &plDebugManagerTestConnector{engine: e}, &plDebugManagerTestConnector{engine: e}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	start := map[string]interface{}{"agentSessionId": "a", "operationId": "blocked-abort", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", start))
	r.mu.RLock()
	entry := r.plNativeEntries["blocked-abort"]
	r.mu.RUnlock()
	entry.mu.Lock()
	entry.cleanupDeadline = time.Now().Add(25 * time.Millisecond)
	entry.mu.Unlock()
	closed := make(chan response, 1)
	go func() {
		closed <- plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "blocked-abort"})
	}()
	select {
	case <-e.abortStarted:
	case <-time.After(time.Second):
		t.Fatal("native abort did not start")
	}
	select {
	case resp := <-closed:
		state := plDebugManagerSnapshot(t, resp)
		if state["releaseState"] != "unknown" || state["operationBusy"] != true || state["nativeDebugId"] != "native ' id" {
			t.Fatalf("deadline lost live original abort: %#v", state)
		}
	case <-time.After(time.Second):
		t.Fatal("close waited beyond its original deadline for a driver ignoring cancellation")
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "blocked-abort"}))
	if first.base.tx.base.closes != 0 || second.base.tx.base.closes != 0 || second.base.tx.rollbacks != 0 {
		t.Fatal("deadline closed resources under an active abort")
	}
	select {
	case <-e.abortCancelled:
	case <-time.After(time.Second):
		t.Fatal("original in-flight cancellation did not reach its driver context")
	}
	close(e.abortRelease)
	select {
	case <-entry.cleanupDone:
	case <-time.After(time.Second):
		t.Fatal("original abort completion not observed")
	}
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_status", map[string]interface{}{"debugId": "blocked-abort"}))
	if state["releaseState"] != "unknown" || state["closeRequested"] != true || state["state"] != "unknown" || e.controls != 1 || e.cleanupAttempts != 0 || len(r.sessions) != 1 {
		t.Fatalf("late abort revived/replayed or falsely released the original session: %#v", state)
	}
}

func TestPLDebugNativeManagerCloseCancelsOriginalControlBudget(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), continueStarted: make(chan struct{}), continueRelease: make(chan struct{})}
	first, second := &plDebugManagerTestConnector{engine: e}, &plDebugManagerTestConnector{engine: e}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "busy-close", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
	continued := make(chan response, 1)
	go func() {
		continued <- plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "busy-close"})
	}()
	select {
	case <-e.continueStarted:
	case <-time.After(time.Second):
		t.Fatal("original CONTINUE not dispatched")
	}
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "busy-close"}))
	select {
	case resp := <-continued:
		if resp.Error == nil {
			t.Fatal("canceled original control reported an ordinary pause")
		}
		data := rpcDiagnostics(t, resp)
		if data["operationOutcome"] != "unknown" || data["sessionDisposition"] != "keep" || data["agentSessionId"] != "a" || data["category"] != "sql" {
			t.Fatalf("cancellation lost original error identity: %#v", data)
		}
	case <-time.After(time.Second):
		t.Fatal("close failed to cancel the original control budget")
	}
	if state["releaseState"] != "unknown" || state["closeRequested"] != true || e.controls != 1 || first.base.tx.base.closes != 0 || second.base.tx.base.closes != 0 || second.base.tx.rollbacks != 0 {
		t.Fatalf("busy close falsely released or replayed execution: %#v", state)
	}
	if resp := plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "busy-close"}); resp.Error == nil {
		t.Fatal("late action revived closed target")
	}
}

func TestPLDebugNativeManagerControlPanicRetainsOwnerAndEndsBusyState(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), panicControl: true}
	first := &plDebugManagerTestConnector{engine: e}
	second := &plDebugManagerTestConnector{engine: e, base: plDebugCaptureTestConnector{complete: 1}}
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "panic-control", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
	resp := plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "panic-control"})
	if resp.Error == nil || rpcDiagnostics(t, resp)["operationOutcome"] != "unknown" {
		t.Fatal("driver panic lost structured unknown result")
	}
	if rpcDiagnostics(t, resp)["category"] != "protocol" {
		t.Fatal("agent control panic used an unrecognized error category")
	}
	wire, marshalErr := json.Marshal(resp)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	var decoded struct {
		Error struct {
			Data map[string]interface{} `json:"data"`
		} `json:"error"`
	}
	if err := json.Unmarshal(wire, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Error.Data["category"] != "protocol" || decoded.Error.Data["stage"] != "execute" || decoded.Error.Data["operationOutcome"] != "unknown" || decoded.Error.Data["contractVersion"] != float64(1) || decoded.Error.Data["agentSessionId"] != "a" {
		t.Fatalf("wire error does not carry the existing Core contract: %#v", decoded.Error.Data)
	}
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_status", map[string]interface{}{"debugId": "panic-control"}))
	if state["state"] != "unknown" || state["operationBusy"] != false || state["nativeDebugId"] != "native ' id" {
		t.Fatalf("panic erased identity or left busy forever: %#v", state)
	}
	e.release.Do(func() { close(e.targetRelease) })
	r.mu.RLock()
	entry := r.plNativeEntries["panic-control"]
	r.mu.RUnlock()
	select {
	case <-entry.captureDone:
	case <-time.After(time.Second):
		t.Fatal("original target return was lost after controller panic")
	}
	state = plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "panic-control"}))
	if state["releaseState"] != "unknown" || state["executionOutcome"] != "succeeded" || e.controls != 1 || e.targetAttempts != 1 || first.base.tx.base.closes != 0 {
		t.Fatalf("panic cleanup replayed or changed proven natural success: %#v", state)
	}
}

func TestPLDebugNativeManagerResumesCleanupOnOriginalBreakCompletion(t *testing.T) {
	e := &plDebugManagerTestEngine{targetStarted: make(chan struct{}), targetRelease: make(chan struct{}), continueStarted: make(chan struct{}), continueRelease: make(chan struct{}), holdTargetOnContinue: true}
	first := &plDebugManagerTestConnector{engine: e, breakController: true}
	second := &plDebugManagerTestConnector{engine: e, breakTarget: true, base: plDebugCaptureTestConnector{output: "natural return while canceling😀\n", complete: 1}}
	second.base.tx.base.breakStarted, second.base.tx.base.breakRelease = make(chan struct{}), make(chan struct{})
	second.base.tx.base.closeStarted = make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(second.base.tx.base.breakRelease) }) })
	r := plDebugPairTestRuntime(first, second)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_start", map[string]interface{}{"agentSessionId": "a", "operationId": "break-continuation", "objectType": "ANONYMOUS", "source": "BEGIN NULL; END;"}))
	session, _ := r.session("a")
	// Simulate the already tested synchronous-Break ownership contract at the
	// external driver boundary. This is not an OCI build/binding verification.
	for _, a := range []*plDebugAllocation{session.server.plAllocation, session.server.nativeDebuggeeAllocation()} {
		a.mu.Lock()
		a.oci = true
		a.mu.Unlock()
	}
	continued := make(chan response, 1)
	go func() {
		continued <- plDebugManagerRPC(t, r, "pl_debug_resume", map[string]interface{}{"debugId": "break-continuation"})
	}()
	select {
	case <-e.continueStarted:
	case <-time.After(time.Second):
		t.Fatal("original continuation did not start")
	}
	closed := make(chan response, 1)
	go func() {
		closed <- plDebugManagerRPC(t, r, "pl_debug_close", map[string]interface{}{"debugId": "break-continuation"})
	}()
	select {
	case <-second.base.tx.base.breakStarted:
	case <-time.After(time.Second):
		t.Fatal("original debuggee Break did not start")
	}
	select {
	case resp := <-closed:
		state := plDebugManagerSnapshot(t, resp)
		if state["releaseState"] != "unknown" || state["executionOutcome"] != "succeeded" {
			t.Fatalf("pending Break lost natural return or resource identity: %#v", state)
		}
	case <-time.After(time.Second):
		t.Fatal("close did not publish pending original Break")
	}
	select {
	case <-continued:
	case <-time.After(time.Second):
		t.Fatal("original controller did not return")
	}
	r.mu.RLock()
	entry := r.plNativeEntries["break-continuation"]
	r.mu.RUnlock()
	entry.mu.Lock()
	deadline := entry.cleanupDeadline
	entry.mu.Unlock()
	if second.base.tx.rollbacks != 0 || second.base.tx.base.closes != 0 {
		t.Fatal("cleanup crossed original Break barrier")
	}
	release.Do(func() { close(second.base.tx.base.breakRelease) })
	select {
	case <-second.base.tx.base.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("original Break completion did not resume its cleanup owner")
	}
	entry.mu.Lock()
	done := entry.cleanupDone
	entry.mu.Unlock()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("resumed cleanup did not finish")
	}
	state := plDebugManagerSnapshot(t, plDebugManagerRPC(t, r, "pl_debug_status", map[string]interface{}{"debugId": "break-continuation"}))
	if state["releaseState"] != "released" || state["executionOutcome"] != "succeeded" || state["cancelConfirmed"] != false || first.base.tx.base.breaks != 1 || second.base.tx.base.breaks != 1 || second.base.tx.rollbacks != 1 || second.base.tx.base.execs != 1 || second.base.stmtCloses != 1 || e.controls != 1 {
		t.Fatalf("continuation replayed or changed original results: %#v", state)
	}
	entry.mu.Lock()
	unchanged := entry.cleanupDeadline.Equal(deadline)
	entry.mu.Unlock()
	if !unchanged {
		t.Fatal("completion notification reset cleanup budget")
	}
}
