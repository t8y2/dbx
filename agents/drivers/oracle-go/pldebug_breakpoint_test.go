package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	go_ora "github.com/sijms/go-ora/v2"
)

type plDebugBreakpointTestConnector struct {
	plDebugManagerTestConnector
	payload                               string
	complete, truncated                   int64
	executionError                        error
	prepares, executions, statementCloses int
	afterPayload                          string
	stops                                 []plDebugNativeStop
	stopIndex                             int
	sets, deletes                         int
	toggles                               int
	toggleEnabled                         bool
	toggleError                           error
	toggleMissing                         bool
	setError, deleteError                 error
	setCode, setRejected                  int64
	readStarted                           chan struct{}
	readUntilCanceled                     bool
	payloads                              []string
	sourceBindings                        []driver.NamedValue
	payloadFor                            func(context.Context, bool) (string, error)
	controlStops                          []plDebugNativeStop
	nativeValue                           func(context.Context, []driver.NamedValue) (driver.Result, error)
}

func (c *plDebugBreakpointTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.plDebugManagerTestConnector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugBreakpointTestConnection{conn.(*plDebugManagerTestConnection), c}, nil
}

type plDebugBreakpointTestConnection struct {
	*plDebugManagerTestConnection
	state *plDebugBreakpointTestConnector
}

func (c *plDebugBreakpointTestConnection) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	if !strings.Contains(query, "SYS.DBMS_DEBUG.SHOW_BREAKPOINTS(listing)") && !strings.Contains(query, "SYS.DBMS_DEBUG.PRINT_BACKTRACE(listing)") && !strings.Contains(query, "SYS.DBMS_DEBUG.SHOW_FRAME_SOURCE") {
		return c.plDebugManagerTestConnection.PrepareContext(ctx, query)
	}
	c.state.prepares++
	return &plDebugBreakpointTestStatement{state: c.state, source: strings.Contains(query, "SYS.DBMS_DEBUG.SHOW_FRAME_SOURCE")}, nil
}

func (c *plDebugBreakpointTestConnection) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if strings.Contains(query, "SYS.DBMS_DEBUG.GET_VALUE") && c.state.nativeValue != nil {
		return c.state.nativeValue(ctx, args)
	}
	if strings.Contains(query, "SYS.DBMS_DEBUG.CONTINUE") && len(c.state.controlStops) > 0 {
		stop := c.state.controlStops[0]
		c.state.controlStops = c.state.controlStops[1:]
		c.owner.engine.mu.Lock()
		c.owner.engine.controls++
		c.owner.engine.mu.Unlock()
		values := []interface{}{stop.Result, stop.Line, stop.Terminated, stop.Breakpoint, stop.StackDepth, stop.InterpreterDepth, stop.Reason, stop.Namespace, stop.Program, stop.Owner, stop.DBLink, stop.ProgramLine, stop.LibUnitType, stop.Entrypoint}
		for i, value := range values {
			if err := plDebugManagerSetOut(args[i], value); err != nil {
				return nil, err
			}
		}
		return driver.RowsAffected(0), nil
	}
	if strings.Contains(query, "SYS.DBMS_DEBUG.ENABLE_BREAKPOINT") || strings.Contains(query, "SYS.DBMS_DEBUG.DISABLE_BREAKPOINT") {
		if args[0].Value != int64(77) {
			return nil, errors.New("toggled a foreign breakpoint")
		}
		c.state.toggles++
		c.state.toggleEnabled = strings.Contains(query, "SYS.DBMS_DEBUG.ENABLE_BREAKPOINT")
		if c.state.toggleError != nil {
			return nil, c.state.toggleError
		}
		if c.state.toggleMissing {
			return driver.RowsAffected(0), nil
		}
		return driver.RowsAffected(0), plDebugManagerSetOut(args[1], sql.NullInt64{Int64: 0, Valid: true})
	}
	if strings.Contains(query, "SYS.DBMS_DEBUG.SET_BREAKPOINT") {
		c.state.sets++
		for _, arg := range args[:4] {
			if arg.Value != nil {
				return nil, errors.New("current program received an invented identity")
			}
		}
		if c.state.setError != nil {
			return nil, c.state.setError
		}
		if err := plDebugManagerSetOut(args[5], sql.NullInt64{Int64: c.state.setCode, Valid: true}); err != nil {
			return nil, err
		}
		if err := plDebugManagerSetOut(args[6], sql.NullInt64{Int64: 77, Valid: c.state.setCode == 0}); err != nil {
			return nil, err
		}
		return driver.RowsAffected(0), plDebugManagerSetOut(args[7], sql.NullInt64{Int64: c.state.setRejected, Valid: true})
	}
	if strings.Contains(query, "SYS.DBMS_DEBUG.DELETE_BREAKPOINT") {
		c.state.deletes++
		if args[0].Value != int64(77) {
			return nil, errors.New("deleted a foreign breakpoint")
		}
		if c.state.deleteError != nil {
			return nil, c.state.deleteError
		}
		return driver.RowsAffected(0), plDebugManagerSetOut(args[1], sql.NullInt64{Int64: 0, Valid: true})
	}
	c.owner.engine.mu.Lock()
	cleanupPhase := c.owner.engine.cleanupPhase
	c.owner.engine.mu.Unlock()
	initial := strings.Contains(query, "SYS.DBMS_DEBUG.SYNCHRONIZE") && !cleanupPhase
	step := strings.Contains(query, "SYS.DBMS_DEBUG.break_any_call")
	if len(c.state.stops) != 0 && (initial || step) {
		if initial {
			if _, err := c.plDebugManagerTestConnection.ExecContext(ctx, query, args); err != nil {
				return nil, err
			}
		} else {
			c.owner.engine.mu.Lock()
			c.owner.engine.controls++
			c.owner.engine.mu.Unlock()
		}
		if c.state.stopIndex >= len(c.state.stops) {
			return nil, errors.New("unbounded automatic entry step")
		}
		s := c.state.stops[c.state.stopIndex]
		c.state.stopIndex++
		if s.Terminated.Valid && s.Terminated.Int64 != 0 {
			c.owner.engine.release.Do(func() { close(c.owner.engine.targetRelease) })
		}
		values := []interface{}{s.Result, s.Line, s.Terminated, s.Breakpoint, s.StackDepth, s.InterpreterDepth, s.Reason, s.Namespace, s.Program, s.Owner, s.DBLink, s.ProgramLine, s.LibUnitType, s.Entrypoint}
		for i, value := range values {
			if err := plDebugManagerSetOut(args[i], value); err != nil {
				return nil, err
			}
		}
		return driver.RowsAffected(0), nil
	}
	return c.plDebugManagerTestConnection.ExecContext(ctx, query, args)
}

type plDebugBreakpointTestStatement struct {
	state  *plDebugBreakpointTestConnector
	source bool
}

func (*plDebugBreakpointTestStatement) NumInput() int                            { return -1 }
func (*plDebugBreakpointTestStatement) CheckNamedValue(*driver.NamedValue) error { return nil }
func (*plDebugBreakpointTestStatement) Exec([]driver.Value) (driver.Result, error) {
	return nil, errors.New("context execution required")
}
func (*plDebugBreakpointTestStatement) Query([]driver.Value) (driver.Rows, error) {
	return nil, errors.New("unexpected query")
}
func (s *plDebugBreakpointTestStatement) Close() error { s.state.statementCloses++; return nil }
func (s *plDebugBreakpointTestStatement) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	s.state.executions++
	if s.state.readUntilCanceled {
		close(s.state.readStarted)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	payload := s.state.payload
	if s.state.executions > 1 && s.state.afterPayload != "" {
		payload = s.state.afterPayload
	}
	if len(s.state.payloads) != 0 {
		if s.state.executions > len(s.state.payloads) {
			return nil, errors.New("unexpected repeated structured read")
		}
		payload = s.state.payloads[s.state.executions-1]
	}
	if s.state.payloadFor != nil {
		var err error
		payload, err = s.state.payloadFor(ctx, s.source)
		if err != nil {
			return nil, err
		}
	}
	prefix := 0
	if s.source {
		prefix = 2
		s.state.sourceBindings = append([]driver.NamedValue{}, args[:2]...)
	}
	if err := plDebugManagerSetOut(args[prefix], go_ora.Clob{String: payload, Valid: true}); err != nil {
		return nil, err
	}
	if err := plDebugManagerSetOut(args[prefix+1], sql.NullInt64{Int64: s.state.complete, Valid: true}); err != nil {
		return nil, err
	}
	if err := plDebugManagerSetOut(args[prefix+2], sql.NullInt64{Int64: s.state.truncated, Valid: true}); err != nil {
		return nil, err
	}
	return driver.RowsAffected(0), s.state.executionError
}

func TestPLDebugNativeBreakpointInventoryReadsWholeStructuredCLOB(t *testing.T) {
	name := " Pkg.\"\n|\x00😀 "
	owner := " Other.Schema "
	line, status := int64(17), int64(2)
	want := []plDebugNativeBreakpoint{}
	for index := 0; index < 512; index++ {
		want = append(want, plDebugNativeBreakpoint{ID: int64(index * 3), Name: &name, Owner: &owner, Line: &line, Status: &status})
	}
	payload, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) <= 32767 {
		t.Fatal("inventory fixture does not cross scalar output limit")
	}
	c := &plDebugBreakpointTestConnector{payload: string(payload), complete: 1}
	r := plDebugConnectTestRuntime(c)
	if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
		t.Fatal(resp.Error)
	}
	s := r.sessions["a"].server
	got, capture, err := plDebugNativeBreakpoints(context.Background(), s.plConnection, s.plAllocation, false)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(got)
	if string(encoded) != string(payload) || capture.ReferencesPending || c.prepares != 1 || c.executions != 1 || c.statementCloses != 1 {
		t.Fatal("inventory changed, truncated, replayed, or retained its statement")
	}
	if err := r.closeAllSessions(); err != nil {
		t.Fatal(err)
	}
}

func TestPLDebugNativeBreakpointInventoryRejectsPartialAndMalformed(t *testing.T) {
	for _, scenario := range []string{"incomplete", "truncated", "duplicate", "null", "malformed", "driver_error", "empty"} {
		t.Run(scenario, func(t *testing.T) {
			c := &plDebugBreakpointTestConnector{payload: "[]", complete: 1}
			switch scenario {
			case "incomplete":
				c.complete = 0
			case "truncated":
				c.truncated = 1
			case "duplicate":
				c.payload = `[{"id":7},{"id":7}]`
			case "null":
				c.payload = "null"
			case "malformed":
				c.payload = "[{"
			case "driver_error":
				c.executionError = errors.New("response transfer failed")
			}
			r := plDebugConnectTestRuntime(c)
			if resp := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "a"}); resp.Error != nil {
				t.Fatal(resp.Error)
			}
			s := r.sessions["a"].server
			got, capture, err := plDebugNativeBreakpoints(context.Background(), s.plConnection, s.plAllocation, false)
			if (err == nil) != (scenario == "empty") || (err != nil && got != nil) || capture.ReferencesPending || c.executions != 1 || c.statementCloses != 1 {
				t.Fatalf("got=%+v capture=%+v err=%v", got, capture, err)
			}
			if err := r.closeAllSessions(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPLDebugNativeSetBreakpointBindsExactOrCurrentProgramWithoutReplay(t *testing.T) {
	for _, current := range []bool{false, true} {
		calls := 0
		namespace, line := int64(1), int64(27)
		owner, name, dblink := " Owner ", " Pkg.\"\n ", "Remote.Name"
		c := &plDebugValueTestConnector{}
		c.execute = func(query string, args []driver.NamedValue) (driver.Result, error) {
			calls++
			if !strings.Contains(query, "SYS.DBMS_DEBUG.SET_BREAKPOINT(program, line_number, breakpoint_number, 0)") {
				t.Fatal("SET_BREAKPOINT did not pass the native line input before its OUT breakpoint number")
			}
			if args[4].Value != line {
				t.Fatal("native line changed")
			}
			if current {
				for _, arg := range args[:4] {
					if arg.Value != nil {
						t.Fatal("current program was filled from a requested label")
					}
				}
			} else if args[0].Value != namespace || args[1].Value != owner || args[2].Value != name || args[3].Value != dblink {
				t.Fatal("program identifiers were transformed")
			}
			return driver.RowsAffected(0), nil
		}
		db := sql.OpenDB(c)
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		var result, number sql.NullInt64
		if current {
			result, number, _, err = plDebugNativeSetBreakpoint(context.Background(), conn, false, nil, nil, nil, nil, line)
		} else {
			result, number, _, err = plDebugNativeSetBreakpoint(context.Background(), conn, false, &namespace, &owner, &name, &dblink, line)
		}
		if err == nil || result.Valid || number.Valid || calls != 1 {
			t.Fatal("incomplete SET result was accepted or replayed")
		}
		conn.Close()
		db.Close()
	}
}
