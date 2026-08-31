package main

import (
	"bufio"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
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
	Columns         []string        `json:"columns"`
	ColumnTypes     []string        `json:"column_types"`
	SpatialColumns  []spatialColumn `json:"spatial_columns,omitempty"`
	SpatialValues   [][]*uint32     `json:"spatial_values,omitempty"`
	Rows            [][]any         `json:"rows"`
	AffectedRows    int64           `json:"affected_rows"`
	ExecutionTimeMS int64           `json:"execution_time_ms"`
	Truncated       bool            `json:"truncated"`
}

type queryPageResult struct {
	Columns         []string        `json:"columns"`
	ColumnTypes     []string        `json:"column_types"`
	SpatialColumns  []spatialColumn `json:"spatial_columns,omitempty"`
	SpatialValues   [][]*uint32     `json:"spatial_values,omitempty"`
	Rows            [][]any         `json:"rows"`
	AffectedRows    int64           `json:"affected_rows"`
	ExecutionTimeMS int64           `json:"execution_time_ms"`
	Truncated       bool            `json:"truncated"`
	SessionID       *string         `json:"session_id"`
	HasMore         bool            `json:"has_more"`
}

type querySession struct {
	rows           *sql.Rows
	conn           *sql.Conn
	columns        []string
	columnTypes    []string
	scanner        *rowScanner
	pending        []any
	pendingSpatial []*uint32
	remaining      int
	cancel         context.CancelFunc
}

type rowScanner struct {
	values       []any
	destinations []any
	spatial      *spatialDecoder
}

type server struct {
	db                              *sql.DB
	openDatabase                    agentDBOpener
	params                          connectParams
	mode                            vastbaseMode
	usePgDefaultExpression          bool
	catalogIdentityUnsupported      bool
	infoColumnTypeUnsupported       bool
	infoUdtNameUnsupported          bool
	constraintDefinitionUnsupported bool
	constraintValidatedUnsupported  bool
	constraintEnabledUnsupported    bool
	listTablesStatement             *sql.Stmt
	connectionRuntime               *connectionRuntime
	sessionAffinity                 bool
	currentSchema                   string
	schemaInitialized               bool
	schemaConnectionID              uintptr
	sessions                        map[string]*querySession
	nextSessionID                   uint64
	activeCancelMu                  sync.Mutex
	activeCancel                    context.CancelFunc
}

type agentSession struct {
	server     *server
	runtimeKey string
	mu         sync.Mutex
}

type runtimeServer struct {
	mu                  sync.RWMutex
	sessions            map[string]*agentSession
	connectionRuntimeMu sync.Mutex
	connectionRuntimes  map[string]*connectionRuntime
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
		return map[string]any{
			"protocolVersion":      protocolVersion,
			"agentProtocolVersion": protocolVersion,
			"capabilities": []string{
				"connect", "test_connection", "metadata", "query", "paged_query", "transaction", "ddl", "multi_session", "structured_error_v1",
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
		release, permitErr := session.server.acquireOperationPermit("validate_session")
		if permitErr != nil {
			return nil, false, permitErr
		}
		defer release()
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
		release, permitErr := session.server.acquireOperationPermit(method)
		if permitErr != nil {
			return nil, false, permitErr
		}
		defer release()
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

	connectionRuntime, runtimeKey := r.acquireConnectionRuntime(cp)
	s := newServer()
	if err := s.connectWithRuntime(cp, connectionRuntime); err != nil {
		r.releaseConnectionRuntime(runtimeKey)
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.sessions[id]; exists {
		_ = s.disconnect()
		r.releaseConnectionRuntime(runtimeKey)
		return fmt.Errorf("agent session already exists: %s", id)
	}
	r.sessions[id] = &agentSession{server: s, runtimeKey: runtimeKey}
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
	err := session.server.disconnect()
	r.releaseConnectionRuntime(session.runtimeKey)
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
	if err := r.closeConnectionRuntimes(); err != nil && firstErr == nil {
		firstErr = err
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
			"capabilities":         []string{"connect", "test_connection", "metadata", "query", "paged_query", "transaction", "ddl", "structured_error_v1"},
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
		result, err := s.testConnection(cp)
		return result, false, err
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
		return agentDataTypes(), false, nil
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
	case "list_constraints":
		result, err := s.listConstraints(stringParam(params, "schema"), stringParam(params, "table"))
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
		opts := queryOptionsFromParams(params)
		result, err := s.executeQuery(opts)
		return result, false, err
	case "execute_query_page", "start_table_read":
		opts := queryOptionsFromParams(params)
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
	s.mode = detectAgentMode(db, cp.MySQLCompatMode)
	s.usePgDefaultExpression = false
	s.catalogIdentityUnsupported = false
	s.infoColumnTypeUnsupported = false
	s.infoUdtNameUnsupported = false
	s.constraintDefinitionUnsupported = false
	s.constraintValidatedUnsupported = false
	s.constraintEnabledUnsupported = false
	s.sessionAffinity = false
	return nil
}

func (s *server) connectWithRuntime(cp connectParams, connectionRuntime *connectionRuntime) error {
	_ = s.disconnect()
	if err := connectionRuntime.validate(cp, s.openDatabase); err != nil {
		return err
	}
	db, err := s.openDatabase(cp, agentInitialSSLMode(effectiveSSLMode(cp)))
	if err != nil {
		return err
	}
	s.db = db
	s.connectionRuntime = connectionRuntime
	s.params = cp
	s.mode = detectAgentMode(connectionRuntime.database(), cp.MySQLCompatMode)
	s.usePgDefaultExpression = false
	s.catalogIdentityUnsupported = false
	s.infoColumnTypeUnsupported = false
	s.infoUdtNameUnsupported = false
	s.constraintDefinitionUnsupported = false
	s.constraintValidatedUnsupported = false
	s.constraintEnabledUnsupported = false
	s.sessionAffinity = false
	return nil
}

func (s *server) testConnection(cp connectParams) (map[string]any, error) {
	db, err := openAndPingDB(cp, defaultConnectTimeout, s.openDatabase)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	temporary := newServer()
	temporary.db = db
	temporary.params = cp
	temporary.mode = detectAgentMode(db, cp.MySQLCompatMode)
	info, err := temporary.connectionInfo()
	if err != nil {
		return nil, err
	}
	result := map[string]any{"ok": true}
	if databaseInfo, ok := info["databaseInfo"]; ok {
		result["databaseInfo"] = databaseInfo
	}
	return result, nil
}

type agentDBOpener func(connectParams, string) (*sql.DB, error)

func openAndPingDB(cp connectParams, timeout time.Duration, opener agentDBOpener) (*sql.DB, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	sslMode := effectiveSSLMode(cp)
	attempts := agentSSLModeAttempts(sslMode)
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
		if index == 0 && len(attempts) > 1 && agentSSLNotSupported(err) {
			continue
		}
		return nil, err
	}
	return nil, fmt.Errorf("%s connection failed", agentKey)
}

func openDBWithSSLMode(cp connectParams, sslMode string) (*sql.DB, error) {
	dsn := buildDSNWithSSLMode(cp, sslMode)
	db, err := sql.Open(agentSQLDriverName, dsn)
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
	s.catalogIdentityUnsupported = false
	s.infoColumnTypeUnsupported = false
	s.infoUdtNameUnsupported = false
	s.constraintDefinitionUnsupported = false
	s.constraintValidatedUnsupported = false
	s.constraintEnabledUnsupported = false
	s.connectionRuntime = nil
	s.sessionAffinity = false
	s.resetSchemaCache()
	if s.listTablesStatement != nil {
		_ = s.listTablesStatement.Close()
		s.listTablesStatement = nil
	}
	if s.db == nil {
		return nil
	}
	err := s.db.Close()
	s.db = nil
	return err
}

func (s *server) validateConnection() error {
	db, err := s.metadataDatabase()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for attempt := 0; attempt < 2; attempt++ {
		err = db.PingContext(ctx)
		if !errors.Is(err, driver.ErrBadConn) {
			return err
		}
	}
	return err
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
	defer s.noteSQLSessionState(sqlText)
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
	defer s.noteSQLSessionState(sqlText)
	if !isQuerySQL(sqlText) {
		result, err := s.executeQuery(opts)
		return queryPageResult{Columns: result.Columns, ColumnTypes: result.ColumnTypes, SpatialColumns: result.SpatialColumns, SpatialValues: result.SpatialValues, Rows: result.Rows, AffectedRows: result.AffectedRows, ExecutionTimeMS: result.ExecutionTimeMS, Truncated: result.Truncated}, err
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
	maxRows := opts.MaxRows
	if maxRows <= 0 {
		maxRows = defaultMaxRows
	}
	columnTypes := columnTypeNames(rows)
	session := &querySession{rows: rows, conn: conn, columns: columns, columnTypes: columnTypes, scanner: newRowScanner(len(columns), newSpatialDecoder(columnTypes)), remaining: maxRows, cancel: cancel}
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
		id := fmt.Sprintf("%s-%d", agentKey, s.nextSessionID)
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
	spatialValues := make([][]*uint32, 0, capacity)
	for len(result.Rows) < pageSize && session.remaining > 0 {
		if session.pending != nil {
			result.Rows = append(result.Rows, session.pending)
			if session.scanner.spatial != nil {
				spatialValues = append(spatialValues, session.pendingSpatial)
			}
			session.pending = nil
			session.pendingSpatial = nil
			session.remaining--
			continue
		}
		if !session.rows.Next() {
			return finishSpatialPage(result, session.scanner.spatial, spatialValues), session.rows.Err()
		}
		row, rowSpatial, err := session.scanner.scan(session.rows)
		if err != nil {
			return queryPageResult{}, err
		}
		result.Rows = append(result.Rows, row)
		if session.scanner.spatial != nil {
			spatialValues = append(spatialValues, rowSpatial)
		}
		session.remaining--
	}
	if session.remaining <= 0 {
		result.Truncated = true
		return finishSpatialPage(result, session.scanner.spatial, spatialValues), nil
	}
	if session.rows.Next() {
		row, rowSpatial, err := session.scanner.scan(session.rows)
		if err != nil {
			return queryPageResult{}, err
		}
		session.pending = row
		session.pendingSpatial = rowSpatial
		result.HasMore = true
	}
	return finishSpatialPage(result, session.scanner.spatial, spatialValues), session.rows.Err()
}

func readRows(rows *sql.Rows, maxRows int) (queryResult, error) {
	columns, err := rows.Columns()
	if err != nil {
		return queryResult{}, err
	}
	columnTypes := columnTypeNames(rows)
	spatial := newSpatialDecoder(columnTypes)
	scanner := newRowScanner(len(columns), spatial)
	result := queryResult{Columns: columns, ColumnTypes: columnTypes, Rows: make([][]any, 0, min(maxRows, 1024))}
	spatialValues := make([][]*uint32, 0, min(maxRows, 1024))
	for rows.Next() {
		if len(result.Rows) >= maxRows {
			result.Truncated = true
			break
		}
		row, rowSpatial, err := scanner.scan(rows)
		if err != nil {
			return queryResult{}, err
		}
		result.Rows = append(result.Rows, row)
		if spatial != nil {
			spatialValues = append(spatialValues, rowSpatial)
		}
	}
	result.SpatialColumns, result.SpatialValues = spatialResultMetadata(spatial, spatialValues)
	return result, rows.Err()
}

func newRowScanner(count int, spatial *spatialDecoder) *rowScanner {
	scanner := &rowScanner{
		values:       make([]any, count),
		destinations: make([]any, count),
		spatial:      spatial,
	}
	for index := range scanner.values {
		scanner.destinations[index] = &scanner.values[index]
	}
	return scanner
}

func (scanner *rowScanner) scan(rows *sql.Rows) ([]any, []*uint32, error) {
	if err := rows.Scan(scanner.destinations...); err != nil {
		return nil, nil, err
	}
	result := make([]any, len(scanner.values))
	copy(result, scanner.values)
	if scanner.spatial != nil {
		return scanner.spatial.normalizeRow(result)
	}
	for index, value := range result {
		result[index] = normalizeValue(value)
	}
	return result, nil, nil
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
	defer func() {
		for _, statement := range statements {
			s.noteSQLSessionState(statement)
		}
	}()
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
	for attempt := 0; attempt < 2; attempt++ {
		conn, connErr := db.Conn(ctx)
		if connErr != nil {
			if attempt == 0 && errors.Is(connErr, driver.ErrBadConn) {
				continue
			}
			return nil, connErr
		}
		connectionID := sqlConnectionIdentity(conn)
		if schemaErr := s.setSchema(ctx, conn, connectionID, schema); schemaErr != nil {
			_ = conn.Close()
			if attempt == 0 && errors.Is(schemaErr, driver.ErrBadConn) {
				s.resetSchemaCache()
				continue
			}
			return nil, schemaErr
		}
		return conn, nil
	}
	return nil, driver.ErrBadConn
}

func (s *server) setSchema(ctx context.Context, conn *sql.Conn, connectionID uintptr, schema string) error {
	schema = strings.TrimSpace(schema)
	if connectionID != 0 && s.schemaInitialized && s.schemaConnectionID == connectionID && s.currentSchema == schema {
		return nil
	}
	if connectionID != 0 && !s.schemaInitialized && schema == "" {
		s.currentSchema = ""
		s.schemaInitialized = true
		s.schemaConnectionID = connectionID
		return nil
	}
	statement := "RESET search_path"
	if schema != "" {
		// Vastbase implicitly prioritizes its system catalog when it is not
		// listed explicitly, matching the JDBC agent and DBeaver behavior.
		statement = "SET search_path TO " + quoteIdentifier(schema)
	}
	if _, err := conn.ExecContext(ctx, statement); err != nil {
		return err
	}
	s.currentSchema = schema
	s.schemaInitialized = true
	s.schemaConnectionID = connectionID
	return nil
}

func buildDSN(cp connectParams) string {
	return buildDSNWithSSLMode(cp, agentInitialSSLMode(effectiveSSLMode(cp)))
}

func buildDSNWithSSLMode(cp connectParams, sslMode string) string {
	if value := strings.TrimSpace(cp.ConnectionString); value != "" && !isAgentJDBCURL(value) {
		return rewriteNativeConnectionStringSSLMode(value, sslMode)
	}
	port := cp.Port
	if port <= 0 {
		port = agentDefaultPort
	}
	parts := []string{
		"host=" + quoteDSNValue(cp.Host),
		fmt.Sprintf("port=%d", port),
		"user=" + quoteDSNValue(cp.Username),
		"password=" + quoteDSNValue(cp.Password),
		"dbname=" + quoteDSNValue(cp.Database),
		"sslmode=" + sslMode,
		"connect_timeout=15",
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
	for _, parameter := range nativeURLParams(cp.URLParams) {
		if !strings.EqualFold(parameter.Key, "sslmode") {
			parts = append(parts, parameter.Key+"="+quoteDSNValue(parameter.Value))
		}
	}
	return strings.Join(parts, " ")
}

func effectiveSSLMode(cp connectParams) string {
	if value := strings.TrimSpace(cp.ConnectionString); value != "" && !isAgentJDBCURL(value) {
		if sslMode, ok := nativeConnectionStringSSLMode(value); ok && sslMode != "" {
			return sslMode
		}
		return "prefer"
	}
	sslMode := ""
	for _, parameter := range nativeURLParams(cp.URLParams) {
		if strings.EqualFold(parameter.Key, "sslmode") {
			sslMode = strings.ToLower(strings.TrimSpace(parameter.Value))
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
	if isAgentNativeURL(value) {
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
	if isAgentNativeURL(value) {
		baseAndQuery, fragment, hasFragment := strings.Cut(value, "#")
		base, query, hasQuery := strings.Cut(baseAndQuery, "?")
		pairs := make([]string, 0)
		if hasQuery {
			for _, pair := range strings.Split(query, "&") {
				key, _, _ := strings.Cut(pair, "=")
				decodedKey, err := url.QueryUnescape(key)
				if err == nil && strings.EqualFold(decodedKey, "sslmode") {
					continue
				}
				if pair != "" {
					pairs = append(pairs, pair)
				}
			}
		}
		pairs = append(pairs, "sslmode="+url.QueryEscape(sslMode))
		result := base + "?" + strings.Join(pairs, "&")
		if hasFragment {
			result += "#" + fragment
		}
		return result
	}

	fields := splitNativeDSNFields(value)
	result := make([]string, 0, len(fields)+1)
	for _, field := range fields {
		key, _, ok := strings.Cut(field, "=")
		if ok && strings.EqualFold(strings.TrimSpace(key), "sslmode") {
			continue
		}
		result = append(result, field)
	}
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

func quoteDSNValue(value string) string {
	return "'" + strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), "'", `\'`) + "'"
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

func errorResponse(id json.RawMessage, method, agentSessionID string, err error) response {
	return response{JSONRPC: "2.0", ID: id, Error: classifyRPCError(method, agentSessionID, err)}
}

func trimStatementSQL(sqlText string) string {
	return strings.TrimRight(strings.TrimSpace(sqlText), "; \t\r\n")
}

func isQuerySQL(sqlText string) bool {
	lower := strings.ToLower(strings.TrimSpace(sqlText))
	return strings.HasPrefix(lower, "select") || strings.HasPrefix(lower, "with") || strings.HasPrefix(lower, "show") || strings.HasPrefix(lower, "explain")
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
