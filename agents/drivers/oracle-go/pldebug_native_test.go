package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"reflect"
	"strings"
	"testing"

	go_ora "github.com/sijms/go-ora/v2"
)

type plDebugNativeControlTestConnector struct {
	base    plDebugConnectTestConnector
	outputs []interface{}
	query   string
	calls   int
}

func (c *plDebugNativeControlTestConnector) Driver() driver.Driver { return c.base.Driver() }
func (c *plDebugNativeControlTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.base.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugNativeControlTestConnection{plDebugConnectTestConnection: conn.(*plDebugConnectTestConnection), state: c}, nil
}

type plDebugNativeControlTestConnection struct {
	*plDebugConnectTestConnection
	state *plDebugNativeControlTestConnector
}

func (*plDebugNativeControlTestConnection) CheckNamedValue(*driver.NamedValue) error { return nil }
func (c *plDebugNativeControlTestConnection) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.query = query
	c.state.calls++
	if !strings.Contains(query, "SYS.DBMS_DEBUG.") || strings.Contains(query, "DBX_PL_DEBUG_PACKAGE") {
		return nil, errors.New("not a native system call")
	}
	if len(args) != len(c.state.outputs) {
		return nil, errors.New("wrong native OUT shape")
	}
	for i, arg := range args {
		var dest interface{}
		switch out := arg.Value.(type) {
		case sql.Out:
			dest = out.Dest
		case go_ora.Out:
			dest = out.Dest
		default:
			return nil, errors.New("native OUT missing")
		}
		reflect.ValueOf(dest).Elem().Set(reflect.ValueOf(c.state.outputs[i]))
	}
	return driver.RowsAffected(0), nil
}

func TestPLDebugNativeControlKeepsStructuredRuntimeFields(t *testing.T) {
	for _, profile := range []string{"thin", "oci"} {
		t.Run(profile, func(t *testing.T) {
			integer := func(n int64) sql.NullInt64 { return sql.NullInt64{Int64: n, Valid: true} }
			text := func(s string) sql.NullString { return sql.NullString{String: s, Valid: true} }
			program := " outer, run_info.reason = 15\n\"Quoted.Name\" "
			c := &plDebugNativeControlTestConnector{outputs: []interface{}{integer(0), integer(27), integer(0), sql.NullInt64{}, integer(3), integer(1), integer(9), integer(2), text(program), text("Mixed Owner"), sql.NullString{}, integer(27), integer(2), text("Leaf.Member")}}
			r := plDebugConnectTestRuntime(c)
			resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a","driver_profile":"` + profile + `"}}`)
			if resp.Error != nil {
				t.Fatal(resp.Error)
			}
			t.Cleanup(func() { _ = r.closeAllSessions() })
			s, _ := r.session("a")
			stop, err := plDebugNativeControl(context.Background(), s.server.plConnection, profile == "oci", procCntNextLine)
			if err != nil {
				t.Fatal(err)
			}
			if stop.Program.String != program || stop.Owner.String != "Mixed Owner" || stop.Line.Int64 != 27 || stop.StackDepth.Int64 != 3 || stop.Terminated.Int64 != 0 || !stop.Terminated.Valid || stop.Breakpoint.Valid || stop.DBLink.Valid {
				t.Fatalf("native fields lost their identity or null state: %+v", stop)
			}
			if !strings.Contains(c.query, "SYS.DBMS_DEBUG.break_next_line") || !strings.Contains(c.query, "run_info.stackdepth") {
				t.Fatal("author control flags or native runtime shape changed")
			}
			if _, err := plDebugNativeControl(context.Background(), s.server.plConnection, profile == "oci", "unrecognized"); err == nil || c.calls != 1 {
				t.Fatal("unknown control action dispatched SQL")
			}
			c.outputs[0] = integer(-1)
			stop, err = plDebugNativeControl(context.Background(), s.server.plConnection, profile == "oci", procCntStepIn)
			if err != nil || !stop.Result.Valid || stop.Result.Int64 != -1 {
				t.Fatalf("raw result code was lost: %+v %v", stop, err)
			}
			c.outputs[0] = sql.NullInt64{}
			if _, err := plDebugNativeControl(context.Background(), s.server.plConnection, profile == "oci", procSynchronize); err == nil {
				t.Fatal("unassigned native result was reported as success")
			}
		})
	}
}

func TestPLDebugNativeInitializePreservesOriginalIdentifier(t *testing.T) {
	c := &plDebugNativeControlTestConnector{outputs: []interface{}{sql.NullString{String: "  debug-id  ", Valid: true}}}
	r := plDebugConnectTestRuntime(c)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	t.Cleanup(func() { _ = r.closeAllSessions() })
	s, _ := r.session("a")
	id, err := plDebugNativeInitialize(context.Background(), s.server.plConnection, false)
	if err != nil || id != "  debug-id  " {
		t.Fatalf("id=%q error=%v", id, err)
	}
	c.outputs = []interface{}{sql.NullString{}}
	if _, err := plDebugNativeInitialize(context.Background(), s.server.plConnection, false); err == nil {
		t.Fatal("missing native identifier was reported initialized")
	}
	if c.calls != 2 {
		t.Fatal("initialization was implicitly retried")
	}
}
