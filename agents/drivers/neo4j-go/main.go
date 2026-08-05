package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	neo4j "github.com/neo4j/neo4j-go-driver/v6/neo4j"
)

const (
	protocolVersion      = 2
	defaultMaxRows       = 10000
	defaultPageSize      = 1000
	legacyAgentSessionID = "__legacy__"
	maxAgentSessions     = 256
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
	session     neo4j.Session
	result      neo4j.Result
	ctx         context.Context
	cancel      context.CancelFunc
	columns     []string
	columnTypes []string
	remaining   int
}

type connectionRuntime struct {
	driver     neo4j.Driver
	params     connectParams
	references int
	closed     bool
	mu         sync.Mutex
}

type server struct {
	runtime        *connectionRuntime
	params         connectParams
	querySessions  map[string]*querySession
	nextSessionID  uint64
	activeCancelMu sync.Mutex
	activeCancel   context.CancelFunc
}

type agentSession struct {
	server     *server
	runtimeKey string
	mu         sync.Mutex
}

type runtimeServer struct {
	mu         sync.RWMutex
	sessions   map[string]*agentSession
	runtimesMu sync.Mutex
	runtimes   map[string]*connectionRuntime
}

func main() {
	configureRuntimeParallelism()
	runtime := newRuntimeServer()
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
			result, _ := runtime.handleLine(line)
			encoderMu.Lock()
			_ = encoder.Encode(result)
			encoderMu.Unlock()
			return
		}
		requests.Add(1)
		go func(line string) {
			defer requests.Done()
			result, _ := runtime.handleLine(line)
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
	if raw := strings.TrimSpace(os.Getenv("DBX_AGENT_NEO4J_GOMAXPROCS")); raw != "" {
		if configured, err := strconv.Atoi(raw); err == nil && configured > 0 {
			runtime.GOMAXPROCS(configured)
			return
		}
	}
	if strings.TrimSpace(os.Getenv("GOMAXPROCS")) != "" {
		return
	}
	runtime.GOMAXPROCS(min(runtime.NumCPU(), 4))
}

func newRuntimeServer() *runtimeServer {
	return &runtimeServer{
		sessions: map[string]*agentSession{},
		runtimes: map[string]*connectionRuntime{},
	}
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
		return handshakeResult(), false, nil
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
		return map[string]bool{"ok": true}, false, testConnection(connection)
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

	runtime, key, err := r.acquireRuntime(params)
	if err != nil {
		return err
	}
	server := newServer(runtime, params)
	if err := server.validateConnection(); err != nil {
		r.releaseRuntime(key)
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.sessions[id]; exists {
		r.releaseRuntime(key)
		return fmt.Errorf("agent session already exists: %s", id)
	}
	r.sessions[id] = &agentSession{server: server, runtimeKey: key}
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
	err := session.server.disconnect()
	session.mu.Unlock()
	r.releaseRuntime(session.runtimeKey)
	return err
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
	r.runtimesMu.Lock()
	runtimes := r.runtimes
	r.runtimes = map[string]*connectionRuntime{}
	r.runtimesMu.Unlock()
	for _, runtime := range runtimes {
		if err := runtime.close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (r *runtimeServer) acquireRuntime(params connectParams) (*connectionRuntime, string, error) {
	key := connectionRuntimeKey(params)
	r.runtimesMu.Lock()
	defer r.runtimesMu.Unlock()
	runtime := r.runtimes[key]
	if runtime == nil {
		var err error
		runtime, err = newConnectionRuntime(params)
		if err != nil {
			return nil, "", err
		}
		r.runtimes[key] = runtime
	}
	runtime.references++
	return runtime, key, nil
}

func (r *runtimeServer) releaseRuntime(key string) {
	if key == "" {
		return
	}
	r.runtimesMu.Lock()
	runtime := r.runtimes[key]
	shouldClose := false
	if runtime != nil && runtime.references > 0 {
		runtime.references--
	}
	if runtime != nil && runtime.references == 0 {
		delete(r.runtimes, key)
		shouldClose = true
	}
	r.runtimesMu.Unlock()
	if shouldClose {
		_ = runtime.close()
	}
}

func connectionRuntimeKey(params connectParams) string {
	data, _ := json.Marshal(params)
	digest := sha256.Sum256(data)
	return fmt.Sprintf("%x", digest[:])
}

func (runtime *connectionRuntime) close() error {
	runtime.mu.Lock()
	if runtime.closed {
		runtime.mu.Unlock()
		return nil
	}
	runtime.closed = true
	driver := runtime.driver
	runtime.mu.Unlock()
	if driver == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return driver.Close(ctx)
}

func newServer(runtime *connectionRuntime, params connectParams) *server {
	return &server{runtime: runtime, params: params, querySessions: map[string]*querySession{}}
}

func handshakeResult() map[string]any {
	return map[string]any{
		"protocolVersion":      protocolVersion,
		"agentProtocolVersion": protocolVersion,
		"capabilities": []string{
			"connect", "test_connection", "metadata", "query", "paged_query", "transaction", "ddl",
			"structured_error_v1", "multi_session",
		},
	}
}

func (s *server) dispatch(method string, params map[string]json.RawMessage) (any, bool, error) {
	switch method {
	case "handshake":
		return handshakeResult(), false, nil
	case "validate_connection":
		return map[string]bool{"ok": true}, false, s.validateConnection()
	case "connection_info":
		result, err := s.connectionInfo()
		return result, false, err
	case "list_databases":
		result, err := s.listDatabases()
		return result, false, err
	case "list_schemas":
		return []string{}, false, nil
	case "list_tables":
		result, err := s.listTables(metadataListConstraintsFromParams(params))
		return result, false, err
	case "get_table_comment":
		return nil, false, nil
	case "list_objects":
		result, err := s.listObjects(metadataListConstraintsFromParams(params))
		return result, false, err
	case "list_data_types":
		return neo4jDataTypes(), false, nil
	case "completion_assistant_search_v1":
		result, err := s.completionAssistantSearch(params)
		return result, false, err
	case "get_columns":
		result, err := s.getColumns(stringParam(params, "table"))
		return result, false, err
	case "list_indexes":
		result, err := s.listIndexes(stringParam(params, "table"))
		return result, false, err
	case "list_foreign_keys", "list_triggers", "list_constraints", "list_partitions", "list_subpartitions":
		return []any{}, false, nil
	case "get_object_source", "get_table_ddl":
		return nil, false, nil
	case "get_explain_info":
		return map[string]any{"plan": "", "has_actual_stats": false}, false, nil
	case "execute_query":
		var options queryOptions
		if err := decodeParams(params, &options); err != nil {
			return nil, false, err
		}
		result, err := s.executeQuery(options)
		return result, false, err
	case "execute_query_page", "start_table_read":
		var options queryOptions
		if err := decodeParams(params, &options); err != nil {
			return nil, false, err
		}
		result, err := s.executeQueryPage(options, intParam(params, "pageSize"))
		return result, false, err
	case "fetch_query_page", "fetch_table_read_page":
		result, err := s.fetchQueryPage(stringParam(params, "sessionId"), intParam(params, "pageSize"))
		return result, false, err
	case "close_query_session", "close_table_read_session":
		return s.closeQuerySession(stringParam(params, "sessionId")), false, nil
	case "execute_transaction":
		result, err := s.executeTransaction(params)
		return result, false, err
	case "execute_batch":
		result, err := s.executeBatch(params)
		return result, false, err
	case "disconnect":
		return map[string]bool{"ok": true}, false, s.disconnect()
	case "shutdown":
		return map[string]bool{"ok": true}, true, s.disconnect()
	default:
		return nil, false, fmt.Errorf("unknown method: %s", method)
	}
}

func (s *server) beginOperation(timeoutSecs int) (context.Context, context.CancelFunc) {
	ctx := context.Background()
	var cancel context.CancelFunc
	if timeoutSecs > 0 {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(timeoutSecs)*time.Second)
	} else {
		ctx, cancel = context.WithCancel(ctx)
	}
	s.activeCancelMu.Lock()
	s.activeCancel = cancel
	s.activeCancelMu.Unlock()
	return ctx, cancel
}

func (s *server) endOperation(cancel context.CancelFunc) {
	cancel()
	s.activeCancelMu.Lock()
	s.activeCancel = nil
	s.activeCancelMu.Unlock()
}

func (s *server) cancelActiveQuery() {
	s.activeCancelMu.Lock()
	cancel := s.activeCancel
	s.activeCancelMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *server) disconnect() error {
	s.cancelActiveQuery()
	return s.closeAllQuerySessions()
}

func decodeParams(params map[string]json.RawMessage, target any) error {
	data, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func stringParam(params map[string]json.RawMessage, key string) string {
	if params == nil {
		return ""
	}
	var result string
	_ = json.Unmarshal(params[key], &result)
	return result
}

func intParam(params map[string]json.RawMessage, key string) int {
	if params == nil {
		return 0
	}
	var result int
	_ = json.Unmarshal(params[key], &result)
	return result
}

func stringSliceParam(params map[string]json.RawMessage, key string) []string {
	if params == nil {
		return []string{}
	}
	var result []string
	if json.Unmarshal(params[key], &result) != nil || result == nil {
		return []string{}
	}
	return result
}
