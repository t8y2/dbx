package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
	_ "time/tzdata"
)

const (
	protocolVersion      = 2
	defaultMaxRows       = 10000
	defaultPageSize      = 1000
	defaultFetchSize     = 50
	legacyAgentSessionID = "__legacy__"
	maxAgentSessions     = 256
	querySessionIdleTime = 10 * time.Minute
)

type request struct {
	ID     json.RawMessage            `json:"id"`
	Method string                     `json:"method"`
	Params map[string]json.RawMessage `json:"params"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type queryOptions struct {
	SQL         string `json:"sql"`
	Database    string `json:"database"`
	Schema      string `json:"schema"`
	MaxRows     int    `json:"maxRows"`
	FetchSize   int    `json:"fetchSize"`
	TimeoutSecs int    `json:"timeoutSecs"`
}

type queryResult struct {
	Columns         []string `json:"columns"`
	ColumnTypes     []string `json:"column_types"`
	Rows            [][]any  `json:"rows"`
	AffectedRows    int64    `json:"affected_rows"`
	ExecutionTimeMS int64    `json:"execution_time_ms"`
	Truncated       bool     `json:"truncated"`
}

type queryPageResult struct {
	Columns         []string `json:"columns"`
	ColumnTypes     []string `json:"column_types"`
	Rows            [][]any  `json:"rows"`
	AffectedRows    int64    `json:"affected_rows"`
	ExecutionTimeMS int64    `json:"execution_time_ms"`
	Truncated       bool     `json:"truncated"`
	SessionID       *string  `json:"session_id"`
	HasMore         bool     `json:"has_more"`
}

type querySession struct {
	rows         *sql.Rows
	columns      []string
	columnTypes  []string
	pending      []any
	remaining    int
	cancel       context.CancelFunc
	lastAccessed time.Time
}

type server struct {
	params connectParams
	config connectionConfig

	connectionMu sync.Mutex
	database     *sql.DB
	connection   *sql.Conn

	querySessions map[string]*querySession
	nextSessionID uint64

	activeMu     sync.Mutex
	activeCancel context.CancelFunc
}

type agentSession struct {
	server *server
	mu     sync.Mutex
}

type runtimeServer struct {
	mu       sync.RWMutex
	sessions map[string]*agentSession
}

func main() {
	configureRuntimeParallelism()
	runtimeServer := newRuntimeServer()
	encoder := json.NewEncoder(os.Stdout)
	var encoderMu sync.Mutex
	var requests sync.WaitGroup
	fmt.Fprintln(os.Stdout, `{"ready":true}`)

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 512*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var envelope request
		if json.Unmarshal([]byte(line), &envelope) == nil && envelope.Method == "shutdown" {
			requests.Wait()
			result, _ := runtimeServer.handleLine(line)
			encoderMu.Lock()
			_ = encoder.Encode(result)
			encoderMu.Unlock()
			return
		}
		requests.Add(1)
		go func(line string) {
			defer requests.Done()
			result, _ := runtimeServer.handleLine(line)
			encoderMu.Lock()
			defer encoderMu.Unlock()
			if err := encoder.Encode(result); err != nil {
				fmt.Fprintf(os.Stderr, "failed to write response: %v\n", err)
			}
		}(line)
	}
	requests.Wait()
}

func configureRuntimeParallelism() {
	if raw := strings.TrimSpace(os.Getenv("DBX_AGENT_HIVE_GOMAXPROCS")); raw != "" {
		if configured, err := strconv.Atoi(raw); err == nil && configured > 0 {
			runtime.GOMAXPROCS(configured)
			return
		}
	}
	if strings.TrimSpace(os.Getenv("GOMAXPROCS")) == "" {
		runtime.GOMAXPROCS(min(runtime.NumCPU(), 4))
	}
}

func newRuntimeServer() *runtimeServer {
	return &runtimeServer{sessions: map[string]*agentSession{}}
}

func (runtimeServer *runtimeServer) handleLine(line string) (response, bool) {
	var request request
	if err := json.Unmarshal([]byte(line), &request); err != nil {
		return errorResponse(nil, "", "", err), false
	}
	if len(request.ID) == 0 {
		request.ID = json.RawMessage("1")
	}
	result, shutdown, err := runtimeServer.dispatch(request.Method, request.Params)
	if err != nil {
		return errorResponse(request.ID, request.Method, stringParam(request.Params, "agentSessionId"), err), false
	}
	return response{JSONRPC: "2.0", ID: request.ID, Result: result}, shutdown
}

func (runtimeServer *runtimeServer) dispatch(method string, params map[string]json.RawMessage) (any, bool, error) {
	switch method {
	case "handshake":
		return handshakeResult(true), false, nil
	case "open_session":
		id := stringParam(params, "agentSessionId")
		if id == "" {
			return nil, false, errors.New("agentSessionId is required")
		}
		var connection connectParams
		if err := decodeParams(params, &connection); err != nil {
			return nil, false, err
		}
		return map[string]bool{"ok": true}, false, runtimeServer.openSession(id, connection)
	case "close_session":
		return map[string]bool{"ok": true}, false, runtimeServer.closeSession(stringParam(params, "agentSessionId"))
	case "validate_session":
		session, err := runtimeServer.session(stringParam(params, "agentSessionId"))
		if err != nil {
			return nil, false, err
		}
		session.mu.Lock()
		defer session.mu.Unlock()
		return map[string]bool{"ok": true}, false, session.server.validateConnection()
	case "cancel_session":
		session, err := runtimeServer.session(stringParam(params, "agentSessionId"))
		if err != nil {
			return nil, false, err
		}
		session.server.cancelActiveQuery()
		return map[string]bool{"ok": true}, false, nil
	case "test_connection":
		var connection connectParams
		if err := decodeParams(params, &connection); err != nil {
			return nil, false, err
		}
		result, err := testConnection(connection)
		return result, false, err
	case "connect":
		var connection connectParams
		if err := decodeParams(params, &connection); err != nil {
			return nil, false, err
		}
		_ = runtimeServer.closeSession(legacyAgentSessionID)
		return map[string]bool{"ok": true}, false, runtimeServer.openSession(legacyAgentSessionID, connection)
	case "disconnect":
		return map[string]bool{"ok": true}, false, runtimeServer.closeSession(legacyAgentSessionID)
	case "shutdown":
		return map[string]bool{"ok": true}, true, runtimeServer.closeAllSessions()
	}

	sessionID := stringParam(params, "agentSessionId")
	if sessionID == "" {
		sessionID = legacyAgentSessionID
	}
	session, err := runtimeServer.session(sessionID)
	if err != nil {
		return nil, false, err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.server.dispatch(method, params)
}

func (runtimeServer *runtimeServer) openSession(id string, params connectParams) error {
	runtimeServer.mu.Lock()
	if len(runtimeServer.sessions) >= maxAgentSessions {
		runtimeServer.mu.Unlock()
		return fmt.Errorf("maximum Hive Agent sessions reached (%d)", maxAgentSessions)
	}
	if _, exists := runtimeServer.sessions[id]; exists {
		runtimeServer.mu.Unlock()
		return fmt.Errorf("Hive Agent session already exists: %s", id)
	}
	runtimeServer.mu.Unlock()

	server, err := newServer(params)
	if err != nil {
		return err
	}
	runtimeServer.mu.Lock()
	defer runtimeServer.mu.Unlock()
	if _, exists := runtimeServer.sessions[id]; exists {
		_ = server.disconnect()
		return fmt.Errorf("Hive Agent session already exists: %s", id)
	}
	if len(runtimeServer.sessions) >= maxAgentSessions {
		_ = server.disconnect()
		return fmt.Errorf("maximum Hive Agent sessions reached (%d)", maxAgentSessions)
	}
	runtimeServer.sessions[id] = &agentSession{server: server}
	return nil
}

func (runtimeServer *runtimeServer) session(id string) (*agentSession, error) {
	runtimeServer.mu.RLock()
	session := runtimeServer.sessions[id]
	runtimeServer.mu.RUnlock()
	if session == nil {
		return nil, fmt.Errorf("Hive Agent session not found: %s", id)
	}
	return session, nil
}

func (runtimeServer *runtimeServer) closeSession(id string) error {
	if id == "" {
		id = legacyAgentSessionID
	}
	runtimeServer.mu.Lock()
	session := runtimeServer.sessions[id]
	delete(runtimeServer.sessions, id)
	runtimeServer.mu.Unlock()
	if session == nil {
		return nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.server.disconnect()
}

func (runtimeServer *runtimeServer) closeAllSessions() error {
	runtimeServer.mu.Lock()
	sessions := runtimeServer.sessions
	runtimeServer.sessions = map[string]*agentSession{}
	runtimeServer.mu.Unlock()
	var failures []string
	for id, session := range sessions {
		session.mu.Lock()
		err := session.server.disconnect()
		session.mu.Unlock()
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", id, err))
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("close Hive Agent sessions: %s", strings.Join(failures, "; "))
	}
	return nil
}

func newServer(params connectParams) (*server, error) {
	config, err := parseConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	server := &server{
		params:        params,
		config:        config,
		querySessions: map[string]*querySession{},
	}
	if err := server.openConnection(); err != nil {
		return nil, err
	}
	return server, nil
}

func (server *server) openConnection() error {
	server.connectionMu.Lock()
	defer server.connectionMu.Unlock()
	if server.connection != nil {
		return nil
	}
	database := openHiveDatabase(server.config)
	ctx, cancel := context.WithTimeout(context.Background(), server.connectionOpenTimeout())
	var connection *sql.Conn
	connection, err := database.Conn(ctx)
	if err == nil {
		err = connection.PingContext(ctx)
	}
	cancel()
	if err == nil {
		err = runHiveInitStatements(context.Background(), connection, server.config.InitStatements, server.config.FetchSize)
	}
	if err != nil {
		if connection != nil {
			_ = connection.Close()
		}
		_ = database.Close()
		return err
	}
	server.database = database
	server.connection = connection
	return nil
}

func (server *server) connectionOpenTimeout() time.Duration {
	timeout := server.config.ConnectTimeout
	if strings.EqualFold(server.config.Auth, "BROWSER") && strings.TrimSpace(server.config.BrowserToken) == "" {
		timeout += server.config.BrowserResponseTimeout
	}
	return timeout
}

func runHiveInitStatements(ctx context.Context, connection *sql.Conn, statements []string, fetchSize int) error {
	for _, statement := range statements {
		rows, _, hasResultSet, err := executeHiveStatement(ctx, connection, statement, fetchSize)
		if err != nil {
			return fmt.Errorf("execute Hive initFile statement: %w", err)
		}
		if !hasResultSet {
			continue
		}
		for rows.Next() {
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			_ = rows.Close()
			return fmt.Errorf("read Hive initFile statement result: %w", rowsErr)
		}
		if closeErr := rows.Close(); closeErr != nil {
			return fmt.Errorf("close Hive initFile statement result: %w", closeErr)
		}
	}
	return nil
}

func (server *server) dispatch(method string, params map[string]json.RawMessage) (any, bool, error) {
	switch method {
	case "validate_connection":
		return map[string]bool{"ok": true}, false, server.validateConnection()
	case "connection_info":
		result, err := server.connectionInfo()
		return result, false, err
	case "list_databases":
		result, err := server.listDatabases()
		return result, false, err
	case "list_schemas":
		result, err := server.listSchemas(stringSliceParam(params, "visible_schemas"))
		return result, false, err
	case "list_tables":
		result, err := server.listTables(stringParam(params, "schema"), metadataListConstraintsFromParams(params))
		return result, false, err
	case "get_table_comment":
		result, err := server.getTableComment(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "list_objects":
		result, err := server.listObjects(stringParam(params, "schema"), metadataListConstraintsFromParams(params))
		return result, false, err
	case "list_data_types":
		result, err := server.listDataTypes()
		return result, false, err
	case "completion_assistant_search_v1":
		var input completionAssistantRequest
		if err := decodeParams(params, &input); err != nil {
			return nil, false, err
		}
		result, err := server.completionAssistantSearch(input)
		return result, false, err
	case "get_columns":
		result, err := server.getColumns(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "list_indexes":
		return []indexInfo{}, false, nil
	case "list_foreign_keys":
		return []foreignKeyInfo{}, false, nil
	case "list_triggers":
		return []triggerInfo{}, false, nil
	case "list_constraints", "list_partitions", "list_subpartitions":
		return []any{}, false, nil
	case "get_object_source":
		result, err := server.getTableDDL(stringParam(params, "schema"), firstNonEmpty(stringParam(params, "name"), stringParam(params, "table")))
		return result, false, err
	case "get_table_ddl":
		result, err := server.getTableDDL(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "get_explain_info":
		result, err := server.getExplainInfo(stringParam(params, "sql"))
		return map[string]any{"plan": result, "has_actual_stats": false}, false, err
	case "execute_query":
		result, err := server.executeQuery(queryOptionsFromParams(params))
		return result, false, err
	case "execute_query_page", "start_table_read":
		result, err := server.executeQueryPage(queryOptionsFromParams(params), intParam(params, "pageSize"))
		return result, false, err
	case "fetch_query_page", "fetch_table_read_page":
		result, err := server.fetchQueryPage(stringParam(params, "sessionId"), intParam(params, "pageSize"))
		return result, false, err
	case "close_query_session", "close_table_read_session":
		return server.closeQuerySession(stringParam(params, "sessionId")), false, nil
	case "execute_transaction":
		result, err := server.executeStatements(params, true)
		return result, false, err
	case "execute_batch":
		result, err := server.executeStatements(params, false)
		return result, false, err
	case "disconnect":
		return map[string]bool{"ok": true}, false, server.disconnect()
	case "shutdown":
		return map[string]bool{"ok": true}, true, server.disconnect()
	default:
		return nil, false, fmt.Errorf("unknown method: %s", method)
	}
}

func handshakeResult(multiSession bool) map[string]any {
	capabilities := []string{
		"connect", "test_connection", "metadata", "query", "paged_query", "transaction", "ddl", "structured_error_v1",
	}
	if multiSession {
		capabilities = append(capabilities, "multi_session")
	}
	return map[string]any{
		"protocolVersion":      protocolVersion,
		"agentProtocolVersion": protocolVersion,
		"capabilities":         capabilities,
	}
}

func testConnection(params connectParams) (map[string]any, error) {
	server, err := newServer(params)
	if err != nil {
		return nil, err
	}
	defer server.disconnect()
	if err := server.validateConnection(); err != nil {
		return nil, err
	}
	info, err := server.connectionInfo()
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "info": info}, nil
}

func (server *server) disconnect() error {
	server.cancelActiveQuery()
	if err := server.closeAllQuerySessions(); err != nil {
		return err
	}
	server.connectionMu.Lock()
	connection := server.connection
	database := server.database
	server.connection = nil
	server.database = nil
	server.connectionMu.Unlock()
	var failures []string
	if connection != nil {
		if err := connection.Close(); err != nil {
			failures = append(failures, err.Error())
		}
	}
	if database != nil {
		if err := database.Close(); err != nil {
			failures = append(failures, err.Error())
		}
	}
	if len(failures) > 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	return nil
}

func (server *server) requireConnection() (*sql.Conn, error) {
	server.connectionMu.Lock()
	connection := server.connection
	server.connectionMu.Unlock()
	if connection == nil {
		return nil, errors.New("Hive connection is not open")
	}
	return connection, nil
}

func (server *server) setActiveOperation(cancel context.CancelFunc) {
	server.activeMu.Lock()
	server.activeCancel = cancel
	server.activeMu.Unlock()
}

func (server *server) clearActiveOperation(cancel context.CancelFunc) {
	cancel()
	server.activeMu.Lock()
	server.activeCancel = nil
	server.activeMu.Unlock()
}

func (server *server) cancelActiveQuery() {
	server.activeMu.Lock()
	cancel := server.activeCancel
	server.activeMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func queryOptionsFromParams(params map[string]json.RawMessage) queryOptions {
	return queryOptions{
		SQL:         stringParam(params, "sql"),
		Database:    stringParam(params, "database"),
		Schema:      stringParam(params, "schema"),
		MaxRows:     intParam(params, "maxRows"),
		FetchSize:   intParam(params, "fetchSize"),
		TimeoutSecs: intParam(params, "timeoutSecs"),
	}
}

func decodeParams(params map[string]json.RawMessage, target any) error {
	data, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func stringParam(params map[string]json.RawMessage, key string) string {
	if raw, ok := params[key]; ok {
		var value string
		if json.Unmarshal(raw, &value) == nil {
			return value
		}
	}
	return ""
}

func intParam(params map[string]json.RawMessage, key string) int {
	if raw, ok := params[key]; ok {
		var value int
		if json.Unmarshal(raw, &value) == nil {
			return value
		}
	}
	return 0
}

func stringSliceParam(params map[string]json.RawMessage, key string) []string {
	raw, ok := params[key]
	if !ok {
		return nil
	}
	var value []string
	if json.Unmarshal(raw, &value) == nil {
		return value
	}
	return nil
}

func errorResponse(id json.RawMessage, method, sessionID string, err error) response {
	return response{JSONRPC: "2.0", ID: id, Error: classifyRPCError(method, sessionID, err)}
}
