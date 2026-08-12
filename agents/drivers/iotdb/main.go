package main

import (
	"bufio"
	"context"
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
	protocolVersion       = 2
	defaultIoTDBPort      = 6667
	defaultMaxRows        = 10000
	defaultPageSize       = 1000
	defaultFetchSize      = 1024
	defaultConnectTimeout = 15 * time.Second
	legacyAgentSessionID  = "__legacy__"
	maxAgentSessions      = 256
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

type connectParams struct {
	Host             string `json:"host"`
	Port             int    `json:"port"`
	Database         string `json:"database"`
	Username         string `json:"username"`
	Password         string `json:"password"`
	URLParams        string `json:"url_params"`
	ConnectionString string `json:"connection_string"`
	SSL              bool   `json:"ssl"`
	CACertPath       string `json:"ca_cert_path"`
	ClientCertPath   string `json:"client_cert_path"`
	ClientKeyPath    string `json:"client_key_path"`
	SessionRole      string `json:"sessionRole"`
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

type server struct {
	params connectParams
	config connectionConfig

	clientMu sync.Mutex
	client   *sessionClient

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
	if raw := strings.TrimSpace(os.Getenv("DBX_AGENT_IOTDB_GOMAXPROCS")); raw != "" {
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

func (r *runtimeServer) handleLine(line string) (response, bool) {
	var req request
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		return errorResponse(nil, "", "", err), false
	}
	if len(req.ID) == 0 {
		req.ID = json.RawMessage("1")
	}
	result, shutdown, err := r.dispatch(req.Method, req.Params)
	if err != nil {
		return errorResponse(req.ID, req.Method, stringParam(req.Params, "agentSessionId"), err), false
	}
	return response{JSONRPC: "2.0", ID: req.ID, Result: result}, shutdown
}

func (r *runtimeServer) dispatch(method string, params map[string]json.RawMessage) (any, bool, error) {
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
		return map[string]bool{"ok": true}, false, r.openSession(id, connection)
	case "close_session":
		return map[string]bool{"ok": true}, false, r.closeSession(stringParam(params, "agentSessionId"))
	case "validate_session":
		session, err := r.session(stringParam(params, "agentSessionId"))
		if err != nil {
			return nil, false, err
		}
		session.mu.Lock()
		defer session.mu.Unlock()
		return map[string]bool{"ok": true}, false, session.server.validateConnection()
	case "cancel_session":
		session, err := r.session(stringParam(params, "agentSessionId"))
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
		_ = r.closeSession(legacyAgentSessionID)
		return map[string]bool{"ok": true}, false, r.openSession(legacyAgentSessionID, connection)
	case "disconnect":
		return map[string]bool{"ok": true}, false, r.closeSession(legacyAgentSessionID)
	case "shutdown":
		return map[string]bool{"ok": true}, true, r.closeAllSessions()
	default:
		id := stringParam(params, "agentSessionId")
		if id == "" {
			id = legacyAgentSessionID
		}
		session, err := r.session(id)
		if err != nil {
			return nil, false, err
		}
		session.mu.Lock()
		defer session.mu.Unlock()
		return session.server.dispatch(method, params)
	}
}

func (r *runtimeServer) openSession(id string, params connectParams) error {
	r.mu.Lock()
	if _, exists := r.sessions[id]; exists {
		r.mu.Unlock()
		return fmt.Errorf("agent session already exists: %s", id)
	}
	if len(r.sessions) >= maxAgentSessions {
		r.mu.Unlock()
		return fmt.Errorf("agent session limit reached: %d", maxAgentSessions)
	}
	r.mu.Unlock()

	server, err := newServer(params)
	if err != nil {
		return err
	}
	if err := server.validateConnection(); err != nil {
		server.disconnect()
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.sessions[id]; exists {
		server.disconnect()
		return fmt.Errorf("agent session already exists: %s", id)
	}
	r.sessions[id] = &agentSession{server: server}
	return nil
}

func (r *runtimeServer) session(id string) (*agentSession, error) {
	r.mu.RLock()
	session := r.sessions[id]
	r.mu.RUnlock()
	if session == nil {
		return nil, fmt.Errorf("agent session not found: %s", id)
	}
	return session, nil
}

func (r *runtimeServer) closeSession(id string) error {
	r.mu.Lock()
	session := r.sessions[id]
	delete(r.sessions, id)
	r.mu.Unlock()
	if session == nil {
		return nil
	}
	session.server.cancelActiveQuery()
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.server.disconnect()
}

func (r *runtimeServer) closeAllSessions() error {
	r.mu.RLock()
	ids := make([]string, 0, len(r.sessions))
	for id := range r.sessions {
		ids = append(ids, id)
	}
	r.mu.RUnlock()
	var firstErr error
	for _, id := range ids {
		if err := r.closeSession(id); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func newServer(params connectParams) (*server, error) {
	config, err := parseConnectionConfig(params)
	if err != nil {
		return nil, err
	}
	return &server{
		params:        params,
		config:        config,
		querySessions: map[string]*querySession{},
	}, nil
}

func (s *server) dispatch(method string, params map[string]json.RawMessage) (any, bool, error) {
	switch method {
	case "handshake":
		return handshakeResult(false), false, nil
	case "validate_connection":
		return map[string]bool{"ok": true}, false, s.validateConnection()
	case "connection_info":
		result, err := s.connectionInfo()
		return result, false, err
	case "list_databases":
		result, err := s.listDatabases()
		return result, false, err
	case "list_schemas":
		result, err := s.listSchemas()
		return result, false, err
	case "list_tables":
		result, err := s.listTables(stringParam(params, "schema"), metadataListConstraintsFromParams(params))
		return result, false, err
	case "get_table_comment":
		result, err := s.getTableComment(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "list_objects":
		result, err := s.listObjects(stringParam(params, "schema"), metadataListConstraintsFromParams(params))
		return result, false, err
	case "list_data_types":
		return iotdbDataTypes(), false, nil
	case "completion_assistant_search_v1":
		var input completionAssistantRequest
		if err := decodeParams(params, &input); err != nil {
			return nil, false, err
		}
		result, err := s.completionAssistantSearch(input)
		return result, false, err
	case "get_columns":
		result, err := s.getColumns(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "list_indexes":
		result, err := s.listIndexes(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "list_foreign_keys", "list_triggers", "list_constraints", "list_partitions", "list_subpartitions":
		return []any{}, false, nil
	case "get_object_source", "get_table_ddl":
		result, err := s.getTableDDL(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "get_explain_info":
		return map[string]any{"plan": "", "has_actual_stats": false}, false, nil
	case "execute_query":
		result, err := s.executeQuery(queryOptionsFromParams(params))
		return result, false, err
	case "execute_query_page", "start_table_read":
		result, err := s.executeQueryPage(queryOptionsFromParams(params), intParam(params, "pageSize"))
		return result, false, err
	case "fetch_query_page", "fetch_table_read_page":
		result, err := s.fetchQueryPage(stringParam(params, "sessionId"), intParam(params, "pageSize"))
		return result, false, err
	case "close_query_session", "close_table_read_session":
		return s.closeQuerySession(stringParam(params, "sessionId")), false, nil
	case "execute_transaction":
		result, err := s.executeStatements(params, true)
		return result, false, err
	case "execute_batch":
		result, err := s.executeStatements(params, false)
		return result, false, err
	case "disconnect":
		return map[string]bool{"ok": true}, false, s.disconnect()
	case "shutdown":
		return map[string]bool{"ok": true}, true, s.disconnect()
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

func (s *server) disconnect() error {
	s.cancelActiveQuery()
	if err := s.closeAllQuerySessions(); err != nil {
		return err
	}
	s.clientMu.Lock()
	client := s.client
	s.client = nil
	s.clientMu.Unlock()
	if client != nil {
		return client.Close()
	}
	return nil
}

func (s *server) setActiveOperation(cancel context.CancelFunc) {
	s.activeMu.Lock()
	s.activeCancel = cancel
	s.activeMu.Unlock()
}

func (s *server) clearActiveOperation(cancel context.CancelFunc) {
	cancel()
	s.activeMu.Lock()
	s.activeCancel = nil
	s.activeMu.Unlock()
}

func (s *server) cancelActiveQuery() {
	s.activeMu.Lock()
	cancel := s.activeCancel
	s.activeMu.Unlock()
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
	if raw, ok := params[key]; ok {
		var value []string
		if json.Unmarshal(raw, &value) == nil && value != nil {
			return value
		}
	}
	return []string{}
}

func errorResponse(id json.RawMessage, method, sessionID string, err error) response {
	return response{JSONRPC: "2.0", ID: id, Error: classifyRPCError(method, sessionID, err)}
}
