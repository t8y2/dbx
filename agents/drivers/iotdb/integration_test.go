package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestLiveIoTDBAgentTreeAndTable(t *testing.T) {
	if os.Getenv("DBX_IOTDB_LIVE") != "1" {
		t.Skip("set DBX_IOTDB_LIVE=1 to run against a real IoTDB server")
	}
	suffix := strconv.Itoa(os.Getpid())
	treeDatabase := "root.dbx_go_agent_" + suffix
	treeDevice := treeDatabase + ".d1"
	treeServer := liveIoTDBServer(t, connectParams{Database: treeDatabase})
	defer treeServer.disconnect()
	defer func() { _ = treeServer.executeNonQuery("DELETE DATABASE "+treeDatabase, "", 0) }()

	mustExecuteNonQuery(t, treeServer, "CREATE DATABASE "+treeDatabase, "")
	mustExecuteNonQuery(t, treeServer, "CREATE TIMESERIES "+treeDevice+".s1 WITH DATATYPE=INT64, ENCODING=RLE", "")
	for index := 1; index <= 4; index++ {
		mustExecuteNonQuery(t, treeServer, fmt.Sprintf("INSERT INTO %s(time,s1) VALUES(%d,%d)", treeDevice, index, index*10), "")
	}

	tables, err := treeServer.listTables(treeDatabase, metadataListConstraints{})
	if err != nil || len(tables) != 1 || tables[0].Name != "d1" {
		t.Fatalf("tree listTables() = %#v, %v", tables, err)
	}
	columns, err := treeServer.getColumns(treeDatabase, "d1")
	if err != nil || len(columns) != 1 || columns[0].Name != "s1" || columns[0].DataType != "INT64" {
		t.Fatalf("tree getColumns() = %#v, %v", columns, err)
	}
	page, err := treeServer.executeQueryPage(queryOptions{SQL: "SELECT * FROM " + treeDevice, MaxRows: 3}, 2)
	if err != nil || len(page.Rows) != 2 || !page.HasMore || page.SessionID == nil {
		t.Fatalf("tree first page = %#v, %v", page, err)
	}
	lastPage, err := treeServer.fetchQueryPage(*page.SessionID, 2)
	if err != nil || len(lastPage.Rows) != 1 || lastPage.HasMore || !lastPage.Truncated {
		t.Fatalf("tree final page = %#v, %v", lastPage, err)
	}
	ddl, err := treeServer.getTableDDL(treeDatabase, "d1")
	if err != nil || !strings.Contains(ddl, "CREATE TIMESERIES "+treeDevice+".s1") {
		t.Fatalf("tree DDL = %q, %v", ddl, err)
	}

	tableDatabase := "dbx_go_agent_" + suffix
	tableParams := liveIoTDBParams()
	tableParams.URLParams = "sql_dialect=table&time_zone=Asia%2FShanghai"
	tableServer := liveIoTDBServer(t, tableParams)
	defer tableServer.disconnect()
	defer func() { _ = tableServer.executeNonQuery("DROP DATABASE "+quoteTableIdentifier(tableDatabase), "", 0) }()

	mustExecuteNonQuery(t, tableServer, "CREATE DATABASE "+quoteTableIdentifier(tableDatabase), "")
	mustExecuteNonQuery(t, tableServer,
		"CREATE TABLE "+quoteTableIdentifier(tableDatabase)+"."+quoteTableIdentifier("d1")+
			" (time TIMESTAMP TIME, device STRING TAG, s1 INT64 FIELD COMMENT 'value') COMMENT 'DBX live test' WITH (TTL='INF')",
		tableDatabase,
	)
	mustExecuteNonQuery(t, tableServer,
		"INSERT INTO "+quoteTableIdentifier("d1")+"(time,device,s1) VALUES(1,'a',10),(2,'a',20)",
		tableDatabase,
	)
	tableColumns, err := tableServer.getColumns(tableDatabase, "d1")
	if err != nil || len(tableColumns) != 3 || !tableColumns[0].IsPrimaryKey || !tableColumns[1].IsPrimaryKey {
		t.Fatalf("table getColumns() = %#v, %v", tableColumns, err)
	}
	comment, err := tableServer.getTableComment(tableDatabase, "d1")
	if err != nil || comment == nil || *comment != "DBX live test" {
		t.Fatalf("table comment = %#v, %v", comment, err)
	}
	result, err := tableServer.executeQuery(queryOptions{SQL: "SELECT * FROM d1 ORDER BY time", Database: tableDatabase, MaxRows: 10})
	if err != nil || len(result.Rows) != 2 || result.Rows[0][0] != "1970-01-01T08:00:00.001+08:00" {
		t.Fatalf("table query = %#v, %v", result, err)
	}
	tableDDL, err := tableServer.getTableDDL(tableDatabase, "d1")
	if err != nil || !strings.Contains(tableDDL, "COMMENT 'DBX live test'") || !strings.Contains(tableDDL, `"device" STRING TAG`) {
		t.Fatalf("table DDL = %q, %v", tableDDL, err)
	}
}

func TestLiveIoTDBAgentTreeDatabaseConnection(t *testing.T) {
	if os.Getenv("DBX_IOTDB_LIVE") != "1" {
		t.Skip("set DBX_IOTDB_LIVE=1 to run against a real IoTDB server")
	}
	database := "root.dbx_go_connection_" + strconv.Itoa(os.Getpid())
	bootstrap := liveIoTDBServer(t, connectParams{})
	defer bootstrap.disconnect()
	mustExecuteNonQuery(t, bootstrap, "CREATE DATABASE "+database, "")
	defer func() { _ = bootstrap.executeNonQuery("DELETE DATABASE "+database, "", 0) }()

	scoped := liveIoTDBServer(t, connectParams{Database: database})
	defer scoped.disconnect()
	if err := scoped.validateConnection(); err != nil {
		t.Fatal(err)
	}
	tables, err := scoped.listTables(database, metadataListConstraints{})
	if err != nil {
		t.Fatal(err)
	}
	if tables == nil {
		t.Fatal("expected an initialized tree table list")
	}
}

func TestLiveIoTDBAgentProcessMultiSessionAndCancellation(t *testing.T) {
	if os.Getenv("DBX_IOTDB_LIVE") != "1" {
		t.Skip("set DBX_IOTDB_LIVE=1 to run against a real IoTDB server")
	}
	process := startIoTDBAgentProcess(t)
	defer process.close()
	treeDatabase := "root.dbx_go_process_" + strconv.Itoa(os.Getpid())
	treeDevice := treeDatabase + ".d1"
	treeParams := liveIoTDBParamsMap()
	treeParams["agentSessionId"] = "tree"
	treeParams["database"] = treeDatabase
	process.call(t, "open_session", treeParams)
	tableParams := liveIoTDBParamsMap()
	tableParams["agentSessionId"] = "table"
	tableParams["url_params"] = "sql_dialect=table"
	process.call(t, "open_session", tableParams)
	process.call(t, "execute_query", map[string]any{"agentSessionId": "tree", "sql": "CREATE DATABASE " + treeDatabase})
	process.call(t, "execute_query", map[string]any{
		"agentSessionId": "tree", "sql": "CREATE TIMESERIES " + treeDevice + ".s1 WITH DATATYPE=INT64, ENCODING=RLE",
	})
	process.call(t, "execute_query", map[string]any{
		"agentSessionId": "tree", "sql": "INSERT INTO " + treeDevice + "(time,s1) VALUES(1,1)",
	})

	treeInfo := process.call(t, "connection_info", map[string]any{"agentSessionId": "tree"})
	tableInfo := process.call(t, "connection_info", map[string]any{"agentSessionId": "table"})
	if treeInfo.(map[string]any)["sqlDialect"] != "TREE" || tableInfo.(map[string]any)["sqlDialect"] != "TABLE" {
		t.Fatalf("unexpected process dialects: tree=%#v table=%#v", treeInfo, tableInfo)
	}

	queryID := process.send(t, "execute_query", map[string]any{
		"agentSessionId": "tree",
		"sql":            "SELECT COUNT(s1) FROM " + treeDevice + " GROUP BY ([0, 1000000000), 1ms)",
		"maxRows":        100000000,
	})
	time.Sleep(250 * time.Millisecond)
	process.call(t, "cancel_session", map[string]any{"agentSessionId": "tree"})
	response := process.waitFor(t, queryID, 10*time.Second)
	if response.Error == nil || response.Error.Data == nil || response.Error.Data.Category != "canceled" {
		t.Fatalf("unexpected cancellation response: %#v", response)
	}
	process.call(t, "validate_session", map[string]any{"agentSessionId": "tree"})
	process.call(t, "execute_query", map[string]any{"agentSessionId": "tree", "sql": "DELETE DATABASE " + treeDatabase})
	process.call(t, "shutdown", nil)
}

func TestIoTDBAgentHelperProcess(t *testing.T) {
	if os.Getenv("DBX_IOTDB_AGENT_HELPER") != "1" {
		return
	}
	main()
	os.Exit(0)
}

func liveIoTDBServer(t *testing.T, params connectParams) *server {
	t.Helper()
	base := liveIoTDBParams()
	if params.Database != "" {
		base.Database = params.Database
	}
	if params.URLParams != "" {
		base.URLParams = params.URLParams
	}
	server, err := newServer(base)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.validateConnection(); err != nil {
		server.disconnect()
		t.Fatal(err)
	}
	return server
}

func liveIoTDBParams() connectParams {
	return connectParams{
		Host:     envOr("DBX_IOTDB_HOST", "127.0.0.1"),
		Port:     envIntOr("DBX_IOTDB_PORT", defaultIoTDBPort),
		Username: envOr("DBX_IOTDB_USER", "root"),
		Password: envOr("DBX_IOTDB_PASSWORD", "root"),
	}
}

func liveIoTDBParamsMap() map[string]any {
	params := liveIoTDBParams()
	return map[string]any{
		"host": params.Host, "port": params.Port, "username": params.Username, "password": params.Password,
	}
}

func mustExecuteNonQuery(t *testing.T, server *server, sql, database string) {
	t.Helper()
	if err := server.executeNonQuery(sql, database, 0); err != nil {
		t.Fatalf("execute %q: %v", sql, err)
	}
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envIntOr(name string, fallback int) int {
	if value, err := strconv.Atoi(os.Getenv(name)); err == nil && value > 0 {
		return value
	}
	return fallback
}

type agentProcessResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result"`
	Error   *rpcError       `json:"error"`
}

type iotdbAgentProcess struct {
	command   *exec.Cmd
	stdin     *json.Encoder
	responses chan agentProcessResponse
	stderr    *synchronizedBuffer
	nextID    int64
	pendingMu sync.Mutex
	pending   map[int64]agentProcessResponse
}

func startIoTDBAgentProcess(t *testing.T) *iotdbAgentProcess {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestIoTDBAgentHelperProcess$")
	command.Env = append(os.Environ(), "DBX_IOTDB_AGENT_HELPER=1")
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	process := &iotdbAgentProcess{
		command: command, stdin: json.NewEncoder(stdin), responses: make(chan agentProcessResponse, 16),
		stderr: &synchronizedBuffer{}, pending: map[int64]agentProcessResponse{},
	}
	command.Stderr = process.stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() || scanner.Text() != `{"ready":true}` {
		process.close()
		t.Fatalf("unexpected ready line %q: %s", scanner.Text(), process.stderr.String())
	}
	go func() {
		for scanner.Scan() {
			var response agentProcessResponse
			if json.Unmarshal(scanner.Bytes(), &response) == nil {
				process.responses <- response
			}
		}
		close(process.responses)
	}()
	return process
}

func (p *iotdbAgentProcess) send(t *testing.T, method string, params map[string]any) int64 {
	t.Helper()
	p.nextID++
	request := map[string]any{"jsonrpc": "2.0", "id": p.nextID, "method": method, "params": params}
	if err := p.stdin.Encode(request); err != nil {
		t.Fatal(err)
	}
	return p.nextID
}

func (p *iotdbAgentProcess) call(t *testing.T, method string, params map[string]any) any {
	t.Helper()
	id := p.send(t, method, params)
	response := p.waitFor(t, id, 10*time.Second)
	if response.Error != nil {
		t.Fatalf("%s failed: %#v", method, response.Error)
	}
	return response.Result
}

func (p *iotdbAgentProcess) waitFor(t *testing.T, id int64, timeout time.Duration) agentProcessResponse {
	t.Helper()
	p.pendingMu.Lock()
	if response, ok := p.pending[id]; ok {
		delete(p.pending, id)
		p.pendingMu.Unlock()
		return response
	}
	p.pendingMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for {
		select {
		case response, ok := <-p.responses:
			if !ok {
				t.Fatalf("agent exited while waiting for %d: %s", id, p.stderr.String())
			}
			var responseID int64
			if err := json.Unmarshal(response.ID, &responseID); err != nil {
				t.Fatalf("invalid response id %s", response.ID)
			}
			if responseID == id {
				return response
			}
			p.pendingMu.Lock()
			p.pending[responseID] = response
			p.pendingMu.Unlock()
		case <-ctx.Done():
			t.Fatalf("timed out waiting for response %d: %s", id, p.stderr.String())
		}
	}
}

func (p *iotdbAgentProcess) close() {
	if p.command.Process == nil || p.command.ProcessState != nil {
		return
	}
	_ = p.command.Process.Kill()
	_ = p.command.Wait()
}

type synchronizedBuffer struct {
	mu      sync.Mutex
	builder strings.Builder
}

func (b *synchronizedBuffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.builder.Write(value)
}

func (b *synchronizedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.builder.String()
}
