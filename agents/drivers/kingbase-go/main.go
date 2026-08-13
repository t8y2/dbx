package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"gitea.com/kingbase/gokb"
)

const (
	protocolVersion       = 2
	defaultMaxRows        = 10000
	legacyAgentSessionID  = "__legacy__"
	maxAgentSessions      = 256
	defaultConnectTimeout = 15 * time.Second
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

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type connectParams struct {
	Host             string `json:"host"`
	Port             int    `json:"port"`
	Database         string `json:"database"`
	Username         string `json:"username"`
	Password         string `json:"password"`
	URLParams        string `json:"url_params"`
	ConnectionString string `json:"connection_string"`
	MySQLCompatMode  bool   `json:"mysql_compat_mode"`
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

type completionAssistantRequest struct {
	ConnectionID  string   `json:"connection_id"`
	Database      string   `json:"database"`
	Schema        string   `json:"schema"`
	ObjectKinds   []string `json:"object_kinds"`
	Mask          string   `json:"mask"`
	CaseSensitive bool     `json:"case_sensitive"`
	GlobalSearch  bool     `json:"global_search"`
	MaxResults    int      `json:"max_results"`
	ParentSchema  string   `json:"parent_schema"`
	ParentName    string   `json:"parent_name"`
	MatchMode     string   `json:"match_mode"`
}

type completionAssistantCandidate struct {
	Name         string  `json:"name"`
	Kind         string  `json:"kind"`
	Database     *string `json:"database"`
	Schema       *string `json:"schema"`
	ParentSchema *string `json:"parent_schema"`
	ParentName   *string `json:"parent_name"`
	Comment      *string `json:"comment"`
	DataType     *string `json:"data_type"`
}

type completionAssistantResponse struct {
	Candidates   []completionAssistantCandidate `json:"candidates"`
	Incomplete   bool                           `json:"incomplete"`
	FallbackUsed bool                           `json:"fallback_used"`
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
	rows        *sql.Rows
	conn        *sql.Conn
	columns     []string
	columnTypes []string
	pending     []any
	remaining   int
	cancel      context.CancelFunc
}

type server struct {
	db                         *sql.DB
	openDatabase               kingbaseDBOpener
	params                     connectParams
	mode                       kingbaseMode
	usePgDefaultExpression     bool
	usePgViewDefinition        bool
	usePgFunctionDefinition    bool
	catalogIdentityUnsupported bool
	catalogOIDUnsupported      bool
	infoColumnTypeUnsupported  bool
	infoUdtNameUnsupported     bool
	currentSchema              string
	schemaSet                  bool
	sessions                   map[string]*querySession
	nextSessionID              uint64
	activeCancelMu             sync.Mutex
	activeCancel               context.CancelFunc
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
	runtime := &runtimeServer{sessions: map[string]*agentSession{}}
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
			resp, _ := runtime.handleLine(line)
			encoderMu.Lock()
			_ = encoder.Encode(resp)
			encoderMu.Unlock()
			return
		}
		requests.Add(1)
		go func(line string) {
			defer requests.Done()
			resp, _ := runtime.handleLine(line)
			encoderMu.Lock()
			defer encoderMu.Unlock()
			if err := encoder.Encode(resp); err != nil {
				fmt.Fprintf(os.Stderr, "failed to write response: %v\n", err)
			}
		}(line)
	}
	requests.Wait()
}

func (r *runtimeServer) handleLine(line string) (response, bool) {
	var req request
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		return errorResponse(nil, err), false
	}
	if len(req.ID) == 0 {
		req.ID = json.RawMessage("1")
	}
	result, shutdown, err := r.dispatch(req.Method, req.Params)
	if err != nil {
		return errorResponse(req.ID, err), false
	}
	return response{JSONRPC: "2.0", ID: req.ID, Result: result}, shutdown
}

func (r *runtimeServer) dispatch(method string, params map[string]json.RawMessage) (any, bool, error) {
	switch method {
	case "handshake":
		return map[string]any{
			"protocolVersion":      protocolVersion,
			"agentProtocolVersion": protocolVersion,
			"capabilities": []string{
				"connect", "test_connection", "metadata", "query", "paged_query", "transaction", "ddl", "multi_session",
			},
		}, false, nil
	case "open_session":
		id := stringParam(params, "agentSessionId")
		if id == "" {
			return nil, false, errors.New("agentSessionId is required")
		}
		var cp connectParams
		if err := decodeParams(params, &cp); err != nil {
			return nil, false, err
		}
		return map[string]bool{"ok": true}, false, r.openSession(id, cp)
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
		return newServer().dispatch(method, params)
	case "connect":
		var cp connectParams
		if err := decodeParams(params, &cp); err != nil {
			return nil, false, err
		}
		_ = r.closeSession(legacyAgentSessionID)
		return map[string]bool{"ok": true}, false, r.openSession(legacyAgentSessionID, cp)
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

func (r *runtimeServer) openSession(id string, cp connectParams) error {
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

	s := newServer()
	if err := s.connect(cp); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.sessions[id]; exists {
		_ = s.disconnect()
		return fmt.Errorf("agent session already exists: %s", id)
	}
	r.sessions[id] = &agentSession{server: s}
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

func newServer() *server {
	return &server{openDatabase: openDBWithSSLMode, sessions: map[string]*querySession{}}
}

func (s *server) dispatch(method string, params map[string]json.RawMessage) (any, bool, error) {
	switch method {
	case "handshake":
		return map[string]any{
			"protocolVersion":      protocolVersion,
			"agentProtocolVersion": protocolVersion,
			"capabilities":         []string{"connect", "test_connection", "metadata", "query", "paged_query", "transaction", "ddl"},
		}, false, nil
	case "connect":
		var cp connectParams
		if err := decodeParams(params, &cp); err != nil {
			return nil, false, err
		}
		return map[string]bool{"ok": true}, false, s.connect(cp)
	case "test_connection":
		var cp connectParams
		if err := decodeParams(params, &cp); err != nil {
			return nil, false, err
		}
		return map[string]bool{"ok": true}, false, s.testConnection(cp)
	case "validate_connection":
		return map[string]bool{"ok": true}, false, s.validateConnection()
	case "connection_info":
		info, err := s.connectionInfo()
		return info, false, err
	case "list_databases":
		result, err := s.listDatabases()
		return result, false, err
	case "list_schemas":
		result, err := s.listSchemas(stringSliceParam(params, "visible_schemas"), boolParam(params, "show_system_schemas"))
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
		return kingbaseDataTypes, false, nil
	case "completion_assistant_search_v1":
		var request completionAssistantRequest
		if err := decodeParams(params, &request); err != nil {
			return nil, false, err
		}
		result, err := s.completionAssistantSearch(request)
		return result, false, err
	case "get_columns":
		result, err := s.getColumns(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "list_indexes":
		result, err := s.listIndexes(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "list_foreign_keys":
		result, err := s.listForeignKeys(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "list_triggers":
		result, err := s.listTriggers(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "get_object_source":
		result, err := s.getObjectSource(stringParam(params, "schema"), stringParam(params, "name"), stringParam(params, "object_type"))
		return result, false, err
	case "get_type_details":
		result, err := s.getTypeDetails(stringParam(params, "schema"), stringParam(params, "name"))
		return result, false, err
	case "get_table_ddl":
		result, err := s.getTableDDL(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "get_explain_info":
		result, err := s.getExplainInfo(stringParam(params, "sql"))
		return map[string]any{"plan": result, "has_actual_stats": false}, false, err
	case "execute_query":
		var opts queryOptions
		if err := decodeParams(params, &opts); err != nil {
			return nil, false, err
		}
		result, err := s.executeQuery(opts)
		return result, false, err
	case "execute_query_page", "start_table_read":
		var opts queryOptions
		if err := decodeParams(params, &opts); err != nil {
			return nil, false, err
		}
		result, err := s.executeQueryPage(opts, intParam(params, "pageSize"))
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

func (s *server) connect(cp connectParams) error {
	_ = s.disconnect()
	db, err := openAndPingDB(cp, defaultConnectTimeout, s.openDatabase)
	if err != nil {
		return err
	}
	s.db = db
	s.params = cp
	s.mode = detectKingbaseMode(db, cp.MySQLCompatMode)
	s.usePgDefaultExpression = false
	s.usePgViewDefinition = false
	s.usePgFunctionDefinition = false
	s.catalogIdentityUnsupported = false
	s.catalogOIDUnsupported = false
	s.infoColumnTypeUnsupported = false
	s.infoUdtNameUnsupported = false
	return nil
}

func (s *server) testConnection(cp connectParams) error {
	db, err := openAndPingDB(cp, defaultConnectTimeout, s.openDatabase)
	if err != nil {
		return err
	}
	defer db.Close()
	return nil
}

type kingbaseDBOpener func(connectParams, string) (*sql.DB, error)

func openAndPingDB(cp connectParams, timeout time.Duration, opener kingbaseDBOpener) (*sql.DB, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	sslMode := effectiveSSLMode(cp)
	attempts := []string{sslMode}
	if sslMode == "prefer" {
		attempts = []string{"require", "disable"}
	}
	for index, attempt := range attempts {
		db, err := opener(cp, attempt)
		if err == nil {
			err = db.PingContext(ctx)
		}
		if err == nil {
			return db, nil
		}
		if db != nil {
			_ = db.Close()
		}
		if index == 0 && len(attempts) == 2 && errors.Is(err, gokb.ErrSSLNotSupported) {
			continue
		}
		return nil, err
	}
	return nil, errors.New("kingbase connection failed")
}

func openDBWithSSLMode(cp connectParams, sslMode string) (*sql.DB, error) {
	dsn := buildDSNWithSSLMode(cp, sslMode)
	db, err := sql.Open("kingbase", dsn)
	if err != nil {
		return nil, err
	}
	// Each protocol session is serialized and owns one database connection.
	// Keeping a single physical connection preserves session state such as
	// search_path and avoids extra pool coordination on the hot query path.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(5 * time.Minute)
	return db, nil
}

func (s *server) disconnect() error {
	s.cancelActiveQuery()
	s.closeAllQuerySessions()
	s.usePgDefaultExpression = false
	s.usePgViewDefinition = false
	s.usePgFunctionDefinition = false
	s.catalogIdentityUnsupported = false
	s.catalogOIDUnsupported = false
	s.infoColumnTypeUnsupported = false
	s.infoUdtNameUnsupported = false
	s.currentSchema = ""
	s.schemaSet = false
	if s.db == nil {
		return nil
	}
	err := s.db.Close()
	s.db = nil
	return err
}

func (s *server) validateConnection() error {
	db, err := s.requireDB()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return db.PingContext(ctx)
}

func (s *server) requireDB() (*sql.DB, error) {
	if s.db == nil {
		return nil, errors.New("not connected")
	}
	return s.db, nil
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

func (s *server) executeQuery(opts queryOptions) (queryResult, error) {
	start := time.Now()
	sqlText := trimStatementSQL(opts.SQL)
	if isQuerySQL(sqlText) {
		rows, conn, cancel, err := s.queryRows(sqlText, opts.Schema, opts.TimeoutSecs)
		if err != nil {
			return queryResult{}, err
		}
		defer func() {
			_ = rows.Close()
			_ = conn.Close()
			s.endOperation(cancel)
		}()
		maxRows := opts.MaxRows
		if maxRows <= 0 {
			maxRows = defaultMaxRows
		}
		result, err := readRows(rows, maxRows)
		result.ExecutionTimeMS = time.Since(start).Milliseconds()
		return result, err
	}
	conn, ctx, cancel, err := s.operationConn(opts.Schema, opts.TimeoutSecs)
	if err != nil {
		return queryResult{}, err
	}
	defer func() {
		_ = conn.Close()
		s.endOperation(cancel)
	}()
	execResult, err := conn.ExecContext(ctx, sqlText)
	if err != nil {
		return queryResult{}, err
	}
	affected, _ := execResult.RowsAffected()
	return queryResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}, AffectedRows: affected, ExecutionTimeMS: time.Since(start).Milliseconds()}, nil
}

func (s *server) queryRows(sqlText string, schema string, timeoutSecs int) (*sql.Rows, *sql.Conn, context.CancelFunc, error) {
	conn, ctx, cancel, err := s.operationConn(schema, timeoutSecs)
	if err != nil {
		return nil, nil, nil, err
	}
	rows, err := conn.QueryContext(ctx, sqlText)
	if err != nil {
		_ = conn.Close()
		s.endOperation(cancel)
		return nil, nil, nil, err
	}
	return rows, conn, cancel, nil
}

func (s *server) executeQueryPage(opts queryOptions, pageSize int) (queryPageResult, error) {
	start := time.Now()
	sqlText := trimStatementSQL(opts.SQL)
	if !isQuerySQL(sqlText) {
		result, err := s.executeQuery(opts)
		return queryPageResult{Columns: result.Columns, ColumnTypes: result.ColumnTypes, Rows: result.Rows, AffectedRows: result.AffectedRows, ExecutionTimeMS: result.ExecutionTimeMS, Truncated: result.Truncated}, err
	}
	rows, conn, cancel, err := s.queryRows(sqlText, opts.Schema, opts.TimeoutSecs)
	if err != nil {
		return queryPageResult{}, err
	}
	columns, err := rows.Columns()
	if err != nil {
		_ = rows.Close()
		_ = conn.Close()
		s.endOperation(cancel)
		return queryPageResult{}, err
	}
	columns = nonNilStrings(columns)
	maxRows := opts.MaxRows
	if maxRows <= 0 {
		maxRows = defaultMaxRows
	}
	session := &querySession{rows: rows, conn: conn, columns: columns, columnTypes: columnTypeNames(rows), remaining: maxRows, cancel: cancel}
	result, err := readQuerySessionPage(session, pageSize)
	result.ExecutionTimeMS = time.Since(start).Milliseconds()
	if err != nil {
		_ = rows.Close()
		_ = conn.Close()
		s.endOperation(cancel)
		return queryPageResult{}, err
	}
	if result.HasMore {
		s.nextSessionID++
		id := fmt.Sprintf("kingbase-%d", s.nextSessionID)
		s.sessions[id] = session
		result.SessionID = &id
	} else {
		_ = rows.Close()
		_ = conn.Close()
		s.endOperation(cancel)
	}
	return result, nil
}

func (s *server) fetchQueryPage(id string, pageSize int) (queryPageResult, error) {
	session := s.sessions[id]
	if session == nil {
		return queryPageResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}}, nil
	}
	result, err := readQuerySessionPage(session, pageSize)
	if err != nil {
		s.closeQuerySession(id)
		return queryPageResult{}, err
	}
	if result.HasMore {
		result.SessionID = &id
	} else {
		s.closeQuerySession(id)
	}
	return result, nil
}

func (s *server) closeQuerySession(id string) bool {
	session := s.sessions[id]
	if session == nil {
		return false
	}
	_ = session.rows.Close()
	if session.conn != nil {
		_ = session.conn.Close()
	}
	if session.cancel != nil {
		s.endOperation(session.cancel)
	}
	delete(s.sessions, id)
	return true
}

func (s *server) closeAllQuerySessions() {
	for id := range s.sessions {
		s.closeQuerySession(id)
	}
}

func readQuerySessionPage(session *querySession, pageSize int) (queryPageResult, error) {
	if pageSize <= 0 {
		pageSize = 100
	}
	capacity := min(pageSize, session.remaining)
	result := queryPageResult{Columns: session.columns, ColumnTypes: session.columnTypes, Rows: make([][]any, 0, capacity)}
	for len(result.Rows) < pageSize && session.remaining > 0 {
		if session.pending != nil {
			result.Rows = append(result.Rows, session.pending)
			session.pending = nil
			session.remaining--
			continue
		}
		if !session.rows.Next() {
			return result, session.rows.Err()
		}
		row, err := scanRow(session.rows, len(session.columns))
		if err != nil {
			return queryPageResult{}, err
		}
		result.Rows = append(result.Rows, row)
		session.remaining--
	}
	if session.remaining <= 0 {
		result.Truncated = true
		return result, nil
	}
	if session.rows.Next() {
		row, err := scanRow(session.rows, len(session.columns))
		if err != nil {
			return queryPageResult{}, err
		}
		session.pending = row
		result.HasMore = true
	}
	return result, session.rows.Err()
}

func readRows(rows *sql.Rows, maxRows int) (queryResult, error) {
	columns, err := rows.Columns()
	if err != nil {
		return queryResult{}, err
	}
	columns = nonNilStrings(columns)
	result := queryResult{Columns: columns, ColumnTypes: columnTypeNames(rows), Rows: make([][]any, 0, min(maxRows, 1024))}
	for rows.Next() {
		if len(result.Rows) >= maxRows {
			result.Truncated = true
			break
		}
		row, err := scanRow(rows, len(columns))
		if err != nil {
			return queryResult{}, err
		}
		result.Rows = append(result.Rows, row)
	}
	return result, rows.Err()
}

func scanRow(rows *sql.Rows, count int) ([]any, error) {
	storage := make([]any, count*2)
	values := storage[:count]
	dest := storage[count:]
	for i := range values {
		dest[i] = &values[i]
	}
	if err := rows.Scan(dest...); err != nil {
		return nil, err
	}
	for i, value := range values {
		values[i] = normalizeValue(value)
	}
	return values, nil
}

func columnTypeNames(rows *sql.Rows) []string {
	types, err := rows.ColumnTypes()
	if err != nil {
		return []string{}
	}
	result := make([]string, len(types))
	for i, columnType := range types {
		result[i] = columnType.DatabaseTypeName()
	}
	return result
}

func (s *server) executeTransaction(params map[string]json.RawMessage) (queryResult, error) {
	statements := stringSliceParam(params, "statements")
	conn, ctx, cancel, err := s.operationConn(stringParam(params, "schema"), intParam(params, "timeoutSecs"))
	if err != nil {
		return queryResult{}, err
	}
	defer func() {
		_ = conn.Close()
		s.endOperation(cancel)
	}()
	start := time.Now()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return queryResult{}, err
	}
	var affected int64
	for _, statement := range statements {
		result, execErr := tx.ExecContext(ctx, trimStatementSQL(statement))
		if execErr != nil {
			_ = tx.Rollback()
			return queryResult{}, execErr
		}
		rows, _ := result.RowsAffected()
		affected += rows
	}
	if err := tx.Commit(); err != nil {
		return queryResult{}, err
	}
	return queryResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}, AffectedRows: affected, ExecutionTimeMS: time.Since(start).Milliseconds()}, nil
}

func (s *server) executeBatch(params map[string]json.RawMessage) (queryResult, error) {
	start := time.Now()
	var affected int64
	for _, statement := range stringSliceParam(params, "statements") {
		result, err := s.executeQuery(queryOptions{SQL: statement, Schema: stringParam(params, "schema")})
		if err != nil {
			return queryResult{}, err
		}
		affected += result.AffectedRows
	}
	return queryResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}, AffectedRows: affected, ExecutionTimeMS: time.Since(start).Milliseconds()}, nil
}

func (s *server) operationConn(schema string, timeoutSecs int) (*sql.Conn, context.Context, context.CancelFunc, error) {
	ctx, cancel := s.beginOperation(timeoutSecs)
	conn, err := s.schemaConn(ctx, schema)
	if err != nil {
		s.endOperation(cancel)
		return nil, nil, nil, err
	}
	return conn, ctx, cancel, nil
}

func (s *server) schemaConn(ctx context.Context, schema string) (*sql.Conn, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.setSchema(ctx, conn, schema); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}

func (s *server) setSchema(ctx context.Context, conn *sql.Conn, schema string) error {
	schema = strings.TrimSpace(schema)
	statement := "RESET search_path"
	if schema != "" {
		// Kingbase implicitly prioritizes its system catalog when it is not
		// listed explicitly, matching the JDBC agent and DBeaver behavior.
		statement = "SET search_path TO " + quoteIdentifier(schema)
	}
	if _, err := conn.ExecContext(ctx, statement); err != nil {
		return err
	}
	s.currentSchema = schema
	s.schemaSet = schema != ""
	return nil
}

func buildDSN(cp connectParams) string {
	sslMode := effectiveSSLMode(cp)
	if sslMode == "prefer" {
		sslMode = "require"
	}
	return buildDSNWithSSLMode(cp, sslMode)
}

func buildDSNWithSSLMode(cp connectParams, sslMode string) string {
	if value := strings.TrimSpace(cp.ConnectionString); value != "" && !isKingbaseJDBCURL(value) {
		return rewriteNativeConnectionStringSSLMode(value, sslMode)
	}
	port := cp.Port
	if port <= 0 {
		port = 54321
	}
	parts := []string{
		"host=" + quoteDSNValue(cp.Host),
		fmt.Sprintf("port=%d", port),
		"user=" + quoteDSNValue(cp.Username),
		"password=" + quoteDSNValue(cp.Password),
		"dbname=" + quoteDSNValue(cp.Database),
		"sslmode=" + sslMode,
	}
	if cp.CACertPath != "" {
		parts = append(parts, "sslrootcert="+quoteDSNValue(cp.CACertPath))
	}
	if cp.ClientCertPath != "" {
		parts = append(parts, "sslcert="+quoteDSNValue(cp.ClientCertPath))
	}
	if cp.ClientKeyPath != "" {
		parts = append(parts, "sslkey="+quoteDSNValue(cp.ClientKeyPath))
	}
	// Classify and de-duplicate the app-supplied url_params. The connect_timeout
	// default is only applied when the user did not provide one (natively or via
	// the connectTimeout alias), so the parameter is never emitted twice.
	urlParams := normalizeURLParams(cp.URLParams)
	if !hasDSNParam(urlParams, "connect_timeout") {
		parts = append(parts, "connect_timeout=15")
	}
	for _, p := range urlParams {
		parts = append(parts, p.key+"="+quoteDSNValue(p.value))
	}
	return strings.Join(parts, " ")
}

func effectiveSSLMode(cp connectParams) string {
	if value := strings.TrimSpace(cp.ConnectionString); value != "" && !isKingbaseJDBCURL(value) {
		if sslMode, ok := nativeConnectionStringSSLMode(value); ok && sslMode != "" {
			return sslMode
		}
		return "prefer"
	}
	sslMode := ""
	for _, pair := range strings.FieldsFunc(cp.URLParams, func(r rune) bool { return r == '&' || r == ';' }) {
		key, value, ok := strings.Cut(pair, "=")
		if ok && strings.EqualFold(strings.TrimSpace(key), "sslmode") {
			sslMode = strings.ToLower(strings.TrimSpace(value))
		}
	}
	if sslMode != "" {
		return sslMode
	}
	if cp.SSL {
		return "verify-full"
	}
	return "prefer"
}

func nativeConnectionStringSSLMode(value string) (string, bool) {
	if strings.HasPrefix(strings.ToLower(value), "kingbase://") {
		query := value
		if _, after, ok := strings.Cut(query, "?"); ok {
			query = after
		} else {
			return "", false
		}
		query, _, _ = strings.Cut(query, "#")
		sslMode := ""
		found := false
		for _, pair := range strings.Split(query, "&") {
			key, rawValue, ok := strings.Cut(pair, "=")
			if !ok {
				continue
			}
			decodedKey, err := url.QueryUnescape(key)
			if err != nil || !strings.EqualFold(decodedKey, "sslmode") {
				continue
			}
			decodedValue, err := url.QueryUnescape(rawValue)
			if err != nil {
				decodedValue = rawValue
			}
			sslMode = strings.ToLower(strings.TrimSpace(decodedValue))
			found = true
		}
		return sslMode, found
	}

	sslMode := ""
	found := false
	for _, field := range splitNativeDSNFields(value) {
		key, rawValue, ok := strings.Cut(field, "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(key), "sslmode") {
			continue
		}
		sslMode = strings.ToLower(unquoteNativeDSNValue(rawValue))
		found = true
	}
	return sslMode, found
}

func rewriteNativeConnectionStringSSLMode(value, sslMode string) string {
	if strings.HasPrefix(strings.ToLower(value), "kingbase://") {
		baseAndQuery, fragment, hasFragment := strings.Cut(value, "#")
		base, query, hasQuery := strings.Cut(baseAndQuery, "?")
		params := make([]dsnParam, 0)
		if hasQuery {
			for _, pair := range strings.Split(query, "&") {
				if pair == "" {
					continue
				}
				rawKey, rawValue, _ := strings.Cut(pair, "=")
				decodedKey, err := url.QueryUnescape(rawKey)
				if err != nil {
					decodedKey = rawKey
				}
				if strings.EqualFold(strings.TrimSpace(decodedKey), "sslmode") {
					continue
				}
				decodedValue, err := url.QueryUnescape(rawValue)
				if err != nil {
					decodedValue = rawValue
				}
				nativeKey, keep := classifyDSNParam(decodedKey, decodedValue)
				if !keep {
					continue
				}
				params = append(params, dsnParam{
					key:       nativeKey,
					value:     rawValue, // preserve the original percent-encoding
					fromAlias: !strings.EqualFold(strings.TrimSpace(decodedKey), nativeKey),
				})
			}
		}
		pairs := make([]string, 0, len(params)+1)
		for _, p := range mergeDSNParams(params) {
			pairs = append(pairs, url.QueryEscape(p.key)+"="+p.value)
		}
		pairs = append(pairs, "sslmode="+url.QueryEscape(sslMode))
		result := base + "?" + strings.Join(pairs, "&")
		if hasFragment {
			result += "#" + fragment
		}
		return result
	}

	fields := splitNativeDSNFields(value)
	params := make([]dsnParam, 0, len(fields))
	passthrough := make([]string, 0)
	for _, field := range fields {
		key, rawValue, ok := strings.Cut(field, "=")
		if !ok {
			passthrough = append(passthrough, field)
			continue
		}
		if strings.EqualFold(strings.TrimSpace(key), "sslmode") {
			continue
		}
		nativeKey, keep := classifyDSNParam(key, unquoteNativeDSNValue(rawValue))
		if !keep {
			continue
		}
		params = append(params, dsnParam{
			key:       nativeKey,
			value:     rawValue, // preserve the original quoting
			fromAlias: !strings.EqualFold(strings.TrimSpace(key), nativeKey),
		})
	}
	result := make([]string, 0, len(params)+len(passthrough)+1)
	for _, p := range mergeDSNParams(params) {
		result = append(result, p.key+"="+p.value)
	}
	result = append(result, passthrough...)
	result = append(result, "sslmode="+sslMode)
	return strings.Join(result, " ")
}

func splitNativeDSNFields(value string) []string {
	fields := make([]string, 0)
	for index := 0; index < len(value); {
		for index < len(value) && isNativeDSNSpace(value[index]) {
			index++
		}
		if index >= len(value) {
			break
		}
		start := index
		for index < len(value) && value[index] != '=' {
			index++
		}
		if index >= len(value) {
			fields = append(fields, strings.TrimSpace(value[start:]))
			break
		}
		index++
		for index < len(value) && isNativeDSNSpace(value[index]) {
			index++
		}
		quoted := index < len(value) && value[index] == '\''
		if quoted {
			index++
		}
		for index < len(value) {
			if value[index] == '\\' && index+1 < len(value) {
				index += 2
				continue
			}
			if quoted {
				if value[index] == '\'' {
					index++
					break
				}
			} else if isNativeDSNSpace(value[index]) {
				break
			}
			index++
		}
		for index < len(value) && !isNativeDSNSpace(value[index]) {
			index++
		}
		fields = append(fields, strings.TrimSpace(value[start:index]))
	}
	return fields
}

func unquoteNativeDSNValue(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
		value = value[1 : len(value)-1]
	}
	return strings.TrimSpace(value)
}

func isNativeDSNSpace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\n' || value == '\r' || value == '\f'
}

func isKingbaseJDBCURL(value string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(value)), "jdbc:kingbase8://")
}

func quoteDSNValue(value string) string {
	return "'" + strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), "'", `\'`) + "'"
}

// supportedDSNParams is the curated set of parameters known to be understood by
// the gokb driver or the Kingbase server. It is no longer a strict allow-list:
// classifyDSNParam also forwards unknown lower_snake_case names to the server as
// run-time parameters, because gokb passes every non-driver-setting to the
// startup packet (conn.go startup()). This set is what classifyDSNParam treats
// as definitely native, which short-circuits the camelCase JDBC heuristic so
// CamelCase GUCs such as DateStyle/TimeZone are still forwarded rather than
// dropped.
//
// The list mirrors the driver's own surface:
//   - gokb conn.go isDriverSetting(): host, port, password, sslmode, sslcert,
//     sslkey, sslrootcert, fallback_application_name, connect_timeout,
//     disable_prepared_binary_result, binary_parameters, krbsrvname, krbspn;
//   - the standard startup keywords user and dbname;
//   - connector.go special handling: client_encoding (must be UTF8),
//     datestyle, extra_float_digits;
//   - common Kingbase/PostgreSQL run-time parameters that can be set in the
//     startup packet: application_name, options, search_path,
//     statement_timeout, work_mem, timezone and friends.
var supportedDSNParams = map[string]struct{}{
	// gokb driver settings (conn.go isDriverSetting) and startup keywords
	"host":                           {},
	"port":                           {},
	"user":                           {},
	"password":                       {},
	"dbname":                         {},
	"sslmode":                        {},
	"sslcert":                        {},
	"sslkey":                         {},
	"sslrootcert":                    {},
	"fallback_application_name":      {},
	"connect_timeout":                {},
	"disable_prepared_binary_result": {},
	"binary_parameters":              {},
	"krbsrvname":                     {},
	"krbspn":                         {},

	// connector.go special handling
	"client_encoding":    {},
	"datestyle":          {},
	"extra_float_digits": {},

	// Common run-time parameters the Kingbase server accepts in the startup
	// packet (PostgreSQL-compatible GUCs).
	"application_name":                    {},
	"options":                             {},
	"search_path":                         {},
	"statement_timeout":                   {},
	"lock_timeout":                        {},
	"idle_in_transaction_session_timeout": {},
	"idle_session_timeout":                {},
	"work_mem":                            {},
	"maintenance_work_mem":                {},
	"temp_buffers":                        {},
	"effective_cache_size":                {},
	"timezone":                            {},
	"intervalstyle":                       {},
	"lc_messages":                         {},
	"lc_monetary":                         {},
	"lc_numeric":                          {},
	"lc_time":                             {},
	"default_transaction_isolation":       {},
	"default_transaction_read_only":       {},
	"default_transaction_deferrable":      {},
	"synchronous_commit":                  {},
	"client_min_messages":                 {},
	"standard_conforming_strings":         {},
	"xmloption":                           {},
	"role":                                {},
	"session_replication_role":            {},
	"default_tablespace":                  {},
	"temp_tablespaces":                    {},
	"default_table_access_method":         {},
	"max_parallel_workers_per_gather":     {},
}

func isSupportedDSNParam(key string) bool {
	_, ok := supportedDSNParams[strings.ToLower(strings.TrimSpace(key))]
	return ok
}

func isSafeParamKey(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	for _, char := range value {
		if !(char == '_' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9') {
			return false
		}
	}
	return true
}

// dsnParam is a single normalized connection parameter ready to be emitted into
// a DSN. value carries the surface-specific text (single-quoted for keyword
// DSNs, percent-encoded for kingbase:// URLs, raw for url_params) so callers can
// preserve the original quoting/encoding when only the key was rewritten.
type dsnParam struct {
	key       string
	value     string
	fromAlias bool
}

// jdbcAliasParams maps a lowercased JDBC property to the native gokb/server
// parameter with equivalent semantics. clientEncoding is handled separately in
// classifyDSNParam because it also has to validate the value.
var jdbcAliasParams = map[string]string{
	"connecttimeout":  "connect_timeout", // both measured in seconds
	"currentschema":   "search_path",     // both accept a comma-separated list
	"applicationname": "application_name",
}

// jdbcOnlyParams lists client-side JDBC/driver properties that have no meaning to
// the Kingbase server. gokb forwards every non-driver-setting to the startup
// packet, so a value the server does not recognize fails the whole connection
// with "unrecognized configuration parameter". camelCase names are also caught by
// the heuristic in classifyDSNParam; this set additionally covers the lowercase
// JDBC properties the heuristic cannot detect and documents intent for the common
// MySQL/JDBC-style names.
var jdbcOnlyParams = map[string]struct{}{
	"usessl":                   {},
	"autoreconnect":            {},
	"characterencoding":        {},
	"servertimezone":           {},
	"rewritebatchedstatements": {},
	"useserverprepstmts":       {},
	"sockettimeout":            {},
	"usecompression":           {},
	"zerodatetimebehavior":     {},
	"useaffectedrows":          {},
	"usecursorfetch":           {},
	"defaultfetchsize":         {},
	"allowmultiqueries":        {},
	"useunicode":               {},
	// Lowercase PgJDBC/Kingbase-JDBC client properties the camelCase heuristic
	// would otherwise forward and break the connection.
	"ssl":             {},
	"sslfactory":      {},
	"stringtype":      {},
	"gsslib":          {},
	"sspiservicename": {},
	"protocolversion": {},
	"loglevel":        {},
}

// classifyDSNParam decides how one connection parameter should be treated and
// returns the native parameter name to emit plus whether to keep it. sslmode is
// handled separately by the callers and must not be passed here. decodedValue is
// the already-unquoted/decoded value, used only for the client_encoding check.
func classifyDSNParam(key, decodedValue string) (nativeKey string, keep bool) {
	trimmed := strings.TrimSpace(key)
	if !isSafeParamKey(trimmed) {
		return "", false
	}
	lower := strings.ToLower(trimmed)

	// client_encoding (native, or via the clientEncoding alias): gokb only
	// accepts UTF-8, so map compatible values and drop everything else — a
	// non-UTF8 value would otherwise fail the whole connection.
	if lower == "client_encoding" || lower == "clientencoding" {
		if isUTF8Encoding(decodedValue) {
			return "client_encoding", true
		}
		return "", false
	}

	// JDBC properties with a direct native equivalent.
	if native, ok := jdbcAliasParams[lower]; ok {
		return native, true
	}

	// Curated native/server parameters are always forwarded. Matching here also
	// keeps CamelCase GUCs such as DateStyle/TimeZone from being mistaken for JDBC
	// camelCase properties by the heuristic below.
	if isSupportedDSNParam(lower) {
		return lower, true
	}

	// Known JDBC-only client properties never reach the server.
	if _, ok := jdbcOnlyParams[lower]; ok {
		return "", false
	}

	// Unknown parameter. Server GUCs are conventionally lower_snake_case while
	// JDBC properties are camelCase, so forward snake_case names as run-time
	// parameters (gokb passes them to the startup packet) and drop names carrying
	// an uppercase letter as presumed client-side JDBC settings.
	if hasUpperASCII(trimmed) {
		return "", false
	}
	return lower, true
}

// mergeDSNParams applies duplicate-parameter precedence: an explicit native
// parameter beats a JDBC alias for the same key, and within the same class the
// first occurrence wins to preserve gokb's existing DSN behavior. Output order
// follows each key's first appearance.
func mergeDSNParams(params []dsnParam) []dsnParam {
	result := make([]dsnParam, 0, len(params))
	pos := make(map[string]int, len(params))
	for _, p := range params {
		if i, ok := pos[p.key]; ok {
			// A later explicit native parameter may replace an earlier alias, but
			// same-class duplicates keep the first value just as gokb does.
			if result[i].fromAlias && !p.fromAlias {
				result[i] = p
			}
			continue
		}
		pos[p.key] = len(result)
		result = append(result, p)
	}
	return result
}

// normalizeURLParams classifies and de-duplicates the app-supplied url_params
// blob (a &/;-separated key=value list), excluding sslmode which is handled
// separately. Values are kept raw for later single-quoting.
func normalizeURLParams(raw string) []dsnParam {
	params := make([]dsnParam, 0)
	for _, pair := range strings.FieldsFunc(raw, func(r rune) bool { return r == '&' || r == ';' }) {
		key, value, ok := strings.Cut(pair, "=")
		if !ok {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(key), "sslmode") {
			continue
		}
		val := strings.TrimSpace(value)
		nativeKey, keep := classifyDSNParam(key, val)
		if !keep {
			continue
		}
		params = append(params, dsnParam{
			key:       nativeKey,
			value:     val,
			fromAlias: !strings.EqualFold(strings.TrimSpace(key), nativeKey),
		})
	}
	return mergeDSNParams(params)
}

func hasDSNParam(params []dsnParam, key string) bool {
	for _, p := range params {
		if p.key == key {
			return true
		}
	}
	return false
}

func hasUpperASCII(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] >= 'A' && value[i] <= 'Z' {
			return true
		}
	}
	return false
}

// isUTF8Encoding mirrors gokb's isUTF8: it recognizes fuzzy variants of "UTF-8"
// (dropping non-alphanumerics, case-insensitively) as well as "unicode".
func isUTF8Encoding(name string) bool {
	var b strings.Builder
	for _, ch := range name {
		switch {
		case ch >= 'A' && ch <= 'Z':
			b.WriteRune(ch + ('a' - 'A'))
		case ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9':
			b.WriteRune(ch)
		}
	}
	s := b.String()
	return s == "utf8" || s == "unicode"
}

func normalizeValue(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case []byte:
		if isTextBytes(typed) {
			return string(typed)
		}
		return map[string]string{"$binary": base64.StdEncoding.EncodeToString(typed)}
	case time.Time:
		return typed.Format(time.RFC3339Nano)
	case int8:
		return int64(typed)
	case int16:
		return int64(typed)
	case int32:
		return int64(typed)
	case float32:
		return float64(typed)
	default:
		return typed
	}
}

func isTextBytes(value []byte) bool {
	for _, char := range value {
		if char == 0 || char < 0x09 || char > 0x0d && char < 0x20 {
			return false
		}
	}
	return true
}

func decodeParams(params map[string]json.RawMessage, target any) error {
	data, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func stringParam(params map[string]json.RawMessage, key string) string {
	var value string
	_ = json.Unmarshal(params[key], &value)
	return value
}

func intParam(params map[string]json.RawMessage, key string) int {
	var value int
	_ = json.Unmarshal(params[key], &value)
	return value
}

func boolParam(params map[string]json.RawMessage, key string) bool {
	var value bool
	if raw, ok := params[key]; ok {
		_ = json.Unmarshal(raw, &value)
	}
	return value
}

func stringSliceParam(params map[string]json.RawMessage, key string) []string {
	var values []string
	if json.Unmarshal(params[key], &values) == nil {
		return values
	}
	return nil
}

func metadataListConstraintsFromParams(params map[string]json.RawMessage) metadataListConstraints {
	return metadataListConstraints{
		Filter:      stringParam(params, "filter"),
		Limit:       intParam(params, "limit"),
		Offset:      intParam(params, "offset"),
		ObjectTypes: stringSliceParam(params, "object_types"),
	}
}

func errorResponse(id json.RawMessage, err error) response {
	return response{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -1, Message: err.Error()}}
}

func trimStatementSQL(sqlText string) string {
	return strings.TrimRight(strings.TrimSpace(sqlText), "; \t\r\n")
}

func isQuerySQL(sqlText string) bool {
	keyword, next := sqlKeywordAt(sqlText, 0)
	if keyword == "with" {
		terminal, terminalEnd := withTerminalKeyword(sqlText, next)
		if terminal == "" || !isStatementKeyword(terminal) {
			return true
		}
		keyword = terminal
		next = terminalEnd
	}
	if keyword == "select" || keyword == "show" || keyword == "explain" || keyword == "values" || keyword == "table" {
		return true
	}
	return isDMLKeyword(keyword) && hasTopLevelSQLKeyword(sqlText, next, "returning")
}

func withTerminalKeyword(sqlText string, index int) (string, int) {
	if keyword, next := sqlKeywordAt(sqlText, index); keyword == "recursive" {
		index = next
	}

	for {
		index = skipSQLTrivia(sqlText, index)
		index = skipSQLIdentifier(sqlText, index)
		if index < 0 {
			return "", index
		}

		index = skipSQLTrivia(sqlText, index)
		if index < len(sqlText) && sqlText[index] == '(' {
			index = skipSQLParenthesized(sqlText, index)
			if index < 0 {
				return "", index
			}
		}

		keyword, next := sqlKeywordAt(sqlText, index)
		if keyword != "as" {
			return "", index
		}
		index = next

		if keyword, next = sqlKeywordAt(sqlText, index); keyword == "not" {
			index = next
			keyword, next = sqlKeywordAt(sqlText, index)
			if keyword != "materialized" {
				return "", index
			}
			index = next
		} else if keyword == "materialized" {
			index = next
		}

		index = skipSQLTrivia(sqlText, index)
		if index >= len(sqlText) || sqlText[index] != '(' {
			return "", index
		}
		index = skipSQLParenthesized(sqlText, index)
		if index < 0 {
			return "", index
		}

		index = skipSQLTrivia(sqlText, index)
		if index < len(sqlText) && sqlText[index] == ',' {
			index++
			continue
		}
		keyword, next = sqlKeywordAt(sqlText, index)
		return keyword, next
	}
}

func hasTopLevelSQLKeyword(sqlText string, index int, target string) bool {
	depth := 0
	for index < len(sqlText) {
		switch sqlText[index] {
		case '\'':
			index = skipSQLQuoted(sqlText, index, '\'')
			if index < 0 {
				return false
			}
			continue
		case '"':
			index = skipSQLQuoted(sqlText, index, '"')
			if index < 0 {
				return false
			}
			continue
		case '$':
			if next := skipSQLDollarQuoted(sqlText, index); next != index {
				if next < 0 {
					return false
				}
				index = next
				continue
			}
		case '-':
			if index+1 < len(sqlText) && sqlText[index+1] == '-' {
				index = skipSQLLineComment(sqlText, index+2)
				continue
			}
		case '/':
			if index+1 < len(sqlText) && sqlText[index+1] == '*' {
				index = skipSQLBlockComment(sqlText, index)
				if index < 0 {
					return false
				}
				continue
			}
		case '(':
			depth++
		case ')':
			depth = max(depth-1, 0)
		default:
			if depth == 0 && isSQLWordStartByte(sqlText[index]) {
				keyword, next := sqlKeywordAt(sqlText, index)
				if keyword == target {
					return true
				}
				index = next
				continue
			}
		}
		index++
	}
	return false
}

func isDMLKeyword(keyword string) bool {
	return keyword == "insert" || keyword == "update" || keyword == "delete" || keyword == "merge"
}

func isStatementKeyword(keyword string) bool {
	return isDMLKeyword(keyword) || keyword == "select" || keyword == "values" || keyword == "table"
}

func sqlKeywordAt(sqlText string, index int) (string, int) {
	index = skipSQLTrivia(sqlText, index)
	if index >= len(sqlText) || !isSQLWordStartByte(sqlText[index]) {
		return "", index
	}
	start := index
	for index < len(sqlText) && isSQLIdentifierByte(sqlText[index]) {
		index++
	}
	return strings.ToLower(sqlText[start:index]), index
}

func skipSQLIdentifier(sqlText string, index int) int {
	index = skipSQLTrivia(sqlText, index)
	if index >= len(sqlText) {
		return -1
	}
	if sqlText[index] == '"' {
		return skipSQLQuoted(sqlText, index, '"')
	}
	start := index
	for index < len(sqlText) && isSQLIdentifierByte(sqlText[index]) {
		index++
	}
	if start == index {
		return -1
	}
	return index
}

func skipSQLParenthesized(sqlText string, index int) int {
	if index >= len(sqlText) || sqlText[index] != '(' {
		return -1
	}
	depth := 0
	for index < len(sqlText) {
		switch sqlText[index] {
		case '\'':
			index = skipSQLQuoted(sqlText, index, '\'')
			if index < 0 {
				return -1
			}
			continue
		case '"':
			index = skipSQLQuoted(sqlText, index, '"')
			if index < 0 {
				return -1
			}
			continue
		case '$':
			if next := skipSQLDollarQuoted(sqlText, index); next != index {
				if next < 0 {
					return -1
				}
				index = next
				continue
			}
		case '-':
			if index+1 < len(sqlText) && sqlText[index+1] == '-' {
				index = skipSQLLineComment(sqlText, index+2)
				continue
			}
		case '/':
			if index+1 < len(sqlText) && sqlText[index+1] == '*' {
				index = skipSQLBlockComment(sqlText, index)
				if index < 0 {
					return -1
				}
				continue
			}
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return index + 1
			}
		}
		index++
	}
	return -1
}

func skipSQLTrivia(sqlText string, index int) int {
	for index < len(sqlText) {
		if isSQLSpace(sqlText[index]) {
			index++
			continue
		}
		if index+1 < len(sqlText) && sqlText[index] == '-' && sqlText[index+1] == '-' {
			index = skipSQLLineComment(sqlText, index+2)
			continue
		}
		if index+1 < len(sqlText) && sqlText[index] == '/' && sqlText[index+1] == '*' {
			index = skipSQLBlockComment(sqlText, index)
			if index < 0 {
				return len(sqlText)
			}
			continue
		}
		break
	}
	return index
}

func skipSQLLineComment(sqlText string, index int) int {
	for index < len(sqlText) && sqlText[index] != '\n' {
		index++
	}
	return index
}

func skipSQLBlockComment(sqlText string, index int) int {
	depth := 0
	for index+1 < len(sqlText) {
		if sqlText[index] == '/' && sqlText[index+1] == '*' {
			depth++
			index += 2
			continue
		}
		if sqlText[index] == '*' && sqlText[index+1] == '/' {
			depth--
			index += 2
			if depth == 0 {
				return index
			}
			continue
		}
		index++
	}
	return -1
}

func skipSQLQuoted(sqlText string, index int, quote byte) int {
	index++
	for index < len(sqlText) {
		if sqlText[index] == '\\' && quote == '\'' && index+1 < len(sqlText) {
			index += 2
			continue
		}
		if sqlText[index] == quote {
			if index+1 < len(sqlText) && sqlText[index+1] == quote {
				index += 2
				continue
			}
			return index + 1
		}
		index++
	}
	return -1
}

func skipSQLDollarQuoted(sqlText string, index int) int {
	endTag := index + 1
	for endTag < len(sqlText) && isSQLDollarTagByte(sqlText[endTag]) {
		endTag++
	}
	if endTag >= len(sqlText) || sqlText[endTag] != '$' {
		return index
	}
	tag := sqlText[index : endTag+1]
	if end := strings.Index(sqlText[endTag+1:], tag); end >= 0 {
		return endTag + 1 + end + len(tag)
	}
	return -1
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func isSQLSpace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n' || value == '\f'
}

func isSQLWordStartByte(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value == '_'
}

func isSQLIdentifierByte(value byte) bool {
	return isSQLWordStartByte(value) || value >= '0' && value <= '9' || value == '$' || value >= 0x80
}

func isSQLDollarTagByte(value byte) bool {
	return isSQLWordStartByte(value) || value >= '0' && value <= '9'
}

func quoteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func quoteLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func stringPtr(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
