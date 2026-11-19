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

type plDebugNativeProbeTestConnector struct {
	base         plDebugConnectTestConnector
	methods      []string
	output       []string
	privileges   []string
	privilegeErr error
	shapeErr     error
	catalogErr   error
	shapes       int
}

func (c *plDebugNativeProbeTestConnector) Driver() driver.Driver { return c.base.Driver() }
func (c *plDebugNativeProbeTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.base.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &plDebugNativeProbeTestConnection{plDebugConnectTestConnection: conn.(*plDebugConnectTestConnection), state: c}, nil
}

type plDebugNativeProbeTestConnection struct {
	*plDebugConnectTestConnection
	state *plDebugNativeProbeTestConnector
}

func (*plDebugNativeProbeTestConnection) CheckNamedValue(*driver.NamedValue) error { return nil }
func (c *plDebugNativeProbeTestConnection) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if strings.Contains(query, "SYS.ALL_PROCEDURES") {
		if c.state.catalogErr != nil {
			return nil, c.state.catalogErr
		}
		names := c.state.methods
		if len(args) != 1 {
			return nil, errors.New("missing package bind")
		}
		if args[0].Value == "DBMS_OUTPUT" {
			names = c.state.output
		} else if args[0].Value != "DBMS_DEBUG" {
			return nil, errors.New("unexpected package")
		}
		return &oracleViewSourceRows{columns: []string{"PROCEDURE_NAME"}, values: plDebugProbeRoutineRows(names)}, nil
	}
	if query == "SELECT PRIVILEGE FROM SESSION_PRIVS" {
		if c.state.privilegeErr != nil {
			return nil, c.state.privilegeErr
		}
		return &oracleViewSourceRows{columns: []string{"PRIVILEGE"}, values: plDebugProbePrivilegeRows(c.state.privileges)}, nil
	}
	for _, versionQuery := range oracleDatabaseVersionQueries {
		if query == versionQuery {
			return &oracleViewSourceRows{columns: []string{"VERSION"}, values: [][]driver.Value{{"Oracle Database 19c 19.0.0.0.0"}}}, nil
		}
	}
	return nil, errors.New("unexpected non-discovery query: " + query)
}
func (c *plDebugNativeProbeTestConnection) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if query != plDebugNativeProbeSQL {
		return nil, errors.New("probe attempted a non-discovery statement: " + query)
	}
	c.state.shapes++
	if c.state.shapeErr != nil {
		return nil, c.state.shapeErr
	}
	for i, arg := range args {
		var dest interface{}
		switch out := arg.Value.(type) {
		case go_ora.Out:
			dest = out.Dest
		case sql.Out:
			dest = out.Dest
		default:
			return nil, errors.New("native version must use OUT binds")
		}
		value, ok := dest.(*int)
		if !ok {
			return nil, errors.New("native version OUT must be integer")
		}
		*value = 0
		if i == 0 {
			*value = 2
		}
	}
	return driver.RowsAffected(0), nil
}

func openNativeProbeTestRuntime(t *testing.T, c *plDebugNativeProbeTestConnector) *runtimeServer {
	t.Helper()
	r := plDebugConnectTestRuntime(c)
	resp, _ := r.handleLine(`{"id":1,"method":"open_session","params":{"agentSessionId":"a"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	t.Cleanup(func() { _ = r.closeAllSessions() })
	return r
}

func TestPLDebugMetadataProbeRPCDoesNotAllocateDebuggerConnections(t *testing.T) {
	c := &plDebugNativeProbeTestConnector{methods: plDebugProbeDebugRoutines, output: []string{"ENABLE", "GET_LINE"}, privileges: []string{"DEBUG CONNECT SESSION"}}
	s := newServer()
	s.db = sql.OpenDB(c)
	t.Cleanup(func() { _ = s.db.Close() })
	r := newRuntimeServer()
	r.sessions["metadata"] = &agentSession{server: s}
	resp, _ := r.handleLine(`{"id":1,"method":"pl_debug_probe","params":{"agentSessionId":"metadata"}}`)
	if resp.Error != nil {
		t.Fatal(resp.Error)
	}
	result := resp.Result.(map[string]interface{})
	if result["canAttemptStart"] != true || result["startVerified"] != false || c.shapes != 1 || c.base.connects != 1 {
		t.Fatalf("metadata probe changed execution ownership: %+v", result)
	}
	if s.plConnection != nil || s.plAllocation != nil || s.plDebuggeeConnection != nil || len(r.plNativeEntries) != 0 {
		t.Fatal("read-only metadata probe allocated dedicated debugger state")
	}
	if s.db.Stats().InUse != 0 {
		t.Fatal("metadata probe retained its borrowed connection")
	}
}

type plDebugInspectTestConnector struct {
	probe  plDebugNativeProbeTestConnector
	target *plDebugTargetTestConnector
}

func (c *plDebugInspectTestConnector) Driver() driver.Driver { return c.probe.Driver() }
func (c *plDebugInspectTestConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.probe.Connect(ctx)
	if err != nil {
		return nil, err
	}
	probe := conn.(*plDebugNativeProbeTestConnection)
	return &plDebugInspectTestConnection{plDebugNativeProbeTestConnection: probe,
		target: &plDebugTargetTestConnection{plDebugConnectTestConnection: probe.plDebugConnectTestConnection, owner: c.target}}, nil
}

type plDebugInspectTestConnection struct {
	*plDebugNativeProbeTestConnection
	target *plDebugTargetTestConnection
}

func (c *plDebugInspectTestConnection) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if strings.Contains(query, "SYS_CONTEXT(") || strings.Contains(query, "FROM SYS.ALL_OBJECTS") ||
		strings.Contains(query, "SELECT SUBPROGRAM_ID") || strings.Contains(query, "FROM SYS.ALL_ARGUMENTS") {
		return c.target.QueryContext(ctx, query, args)
	}
	return c.plDebugNativeProbeTestConnection.QueryContext(ctx, query, args)
}

func TestPLDebugMetadataInspectRPCUsesOnePhysicalConnectionForTheWholePreview(t *testing.T) {
	for _, fail := range []bool{false, true} {
		c := &plDebugInspectTestConnector{target: plDebugTargetFixture(), probe: plDebugNativeProbeTestConnector{
			methods: plDebugProbeDebugRoutines, output: []string{"ENABLE", "GET_LINE"}, privileges: []string{"DEBUG CONNECT SESSION"}}}
		if fail {
			c.target.queryError = errors.New("dictionary unavailable")
		}
		s := newServer()
		s.db = sql.OpenDB(c)
		t.Cleanup(func() { _ = s.db.Close() })
		r := newRuntimeServer()
		r.sessions["metadata"] = &agentSession{server: s}
		target := plDebugTargetRequest()
		delete(target, "agentSessionId")
		response := plDebugManagerRPC(t, r, "pl_debug_inspect", map[string]interface{}{"agentSessionId": "metadata", "target": target})
		if fail {
			if response.Error == nil {
				t.Fatal("partial probe was published after target failure")
			}
		} else {
			result := plDebugManagerSnapshot(t, response)
			probe := result["capabilities"].(map[string]interface{})
			preview := result["targetPreview"].(map[string]interface{})
			if probe["startVerified"] != false || probe["canAttemptStart"] != true || preview["schema"] != c.target.owner || len(preview["candidates"].([]map[string]interface{})) != 2 {
				t.Fatalf("incomplete combined preview: %#v", result)
			}
		}
		if c.probe.base.connects != 1 || c.probe.shapes != 1 || s.db.Stats().InUse != 0 || s.plConnection != nil || len(r.plNativeEntries) != 0 {
			t.Fatal("inspection changed physical ownership or retained a connection")
		}
	}
}

func TestPLDebugDedicatedInspectRPCReusesOriginalSingleSlotAndDoesNotStartTarget(t *testing.T) {
	c := &plDebugInspectTestConnector{target: plDebugTargetFixture(), probe: plDebugNativeProbeTestConnector{methods: plDebugProbeDebugRoutines, output: []string{"ENABLE", "GET_LINE"}, privileges: []string{"DEBUG CONNECT SESSION"}}}
	r := plDebugConnectTestRuntime(c)
	if response := plDebugManagerRPC(t, r, "open_session", map[string]interface{}{"agentSessionId": "inspect"}); response.Error != nil {
		t.Fatal(response.Error)
	}
	t.Cleanup(func() { _ = r.closeAllSessions() })
	target := plDebugTargetRequest()
	delete(target, "agentSessionId")
	response := plDebugManagerRPC(t, r, "pl_debug_inspect", map[string]interface{}{"agentSessionId": "inspect", "target": target})
	if response.Error != nil {
		t.Fatal(response.Error)
	}
	result := plDebugManagerSnapshot(t, response)
	if result["targetPreview"] == nil || result["capabilities"] == nil || c.probe.base.connects != 1 || c.probe.shapes != 1 || len(r.plNativeEntries) != 0 || r.plMetadataBusy || r.sessions["inspect"].server.plDebuggeeAllocation != nil {
		t.Fatal("inspection changed the original single-slot ownership or dispatched a target")
	}
	if err := r.closeSession("inspect"); err != nil {
		t.Fatal(err)
	}
	if len(r.sessions) != 0 {
		t.Fatal("inspection session release was not confirmed")
	}
}

func TestPLDebugSharedMetadataRejectsTypePreparationBeforeDatabaseUse(t *testing.T) {
	s := newServer()
	raw := map[string]json.RawMessage{"target": json.RawMessage(`{"objectType":"PROCEDURE","objectName":"P","metadataPreparation":"type_only"}`)}
	if _, err := s.plDebugInspect(raw); err == nil || !strings.Contains(err.Error(), "dedicated") {
		t.Fatalf("shared metadata preparation not blocked: %v", err)
	}
	if _, err := s.previewNativeTarget(map[string]json.RawMessage{"metadataPreparation": json.RawMessage(`"type_only"`)}); err == nil || !strings.Contains(err.Error(), "dedicated") {
		t.Fatalf("alternate shared route bypassed preparation ownership: %v", err)
	}
}

func TestPLDebugNativeProbeRPCDoesNotClaimTargetExecution(t *testing.T) {
	for _, failure := range []string{"none", "shape-permission", "catalog-hidden"} {
		t.Run(failure, func(t *testing.T) {
			c := &plDebugNativeProbeTestConnector{methods: plDebugProbeDebugRoutines, output: []string{"ENABLE", "GET_LINE"}, privileges: []string{"DEBUG CONNECT SESSION", "DEBUG ANY PROCEDURE"}}
			if failure == "shape-permission" {
				c.shapeErr = errors.New("ORA-01031: insufficient privileges")
			}
			if failure == "catalog-hidden" {
				c.catalogErr = errors.New("ORA-00942: dictionary hidden")
			}
			r := openNativeProbeTestRuntime(t, c)
			resp, _ := r.handleLine(`{"id":2,"method":"pl_debug_probe","params":{"agentSessionId":"a"}}`)
			if resp.Error != nil {
				t.Fatal(resp.Error)
			}
			result := resp.Result.(map[string]interface{})
			if result["startVerified"] != false || c.shapes != 1 || c.base.connects != 1 {
				t.Fatalf("probe executed or changed the target: %+v", result)
			}
			if failure == "shape-permission" {
				if result["status"] != "permission_denied" || result["canAttemptStart"] != false {
					t.Fatalf("permission failure misclassified: %+v", result)
				}
			} else if result["canAttemptStart"] != true || result["status"] != "unknown" {
				t.Fatalf("shape/dictionary evidence was overstated: %+v", result)
			}
			if failure == "catalog-hidden" && result["catalogStatus"] == "unsupported" {
				t.Fatal("hidden dictionary was reported as missing native methods")
			}
		})
	}
}
