package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "gitee.com/XuguDB/go-xugu-driver"
)

const protocolVersion = 1
const multiSessionProtocolVersion = 2
const defaultMaxRows = 1000
const defaultXuguPort = 5138
const legacyAgentSessionID = "__legacy__"
const maxAgentSessions = 256
const xuguListDatabasesSQL = `
SELECT DB_NAME
FROM ALL_DATABASES
ORDER BY DB_NAME`
const xuguListSchemasSQL = `
SELECT SCHEMA_NAME
FROM ALL_SCHEMAS
ORDER BY SCHEMA_NAME`
const xuguPrimaryKeyColumnsSQL = `
SELECT c.DEFINE
FROM ALL_CONSTRAINTS c
JOIN ALL_TABLES t ON t.DB_ID = c.DB_ID AND t.TABLE_ID = c.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)
  AND c.CONS_TYPE = 'P'`
const xuguListColumnsSQL = `
SELECT c.COL_NAME, c.TYPE_NAME, c.NOT_NULL, c.DEF_VAL, c.ON_NULL, c.COMMENTS, c.SCALE, c."VARYING"
FROM ALL_COLUMNS c
JOIN ALL_TABLES t ON t.DB_ID = c.DB_ID AND t.TABLE_ID = c.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)
  AND (c.IS_HIDE IS NULL OR c.IS_HIDE = FALSE)
ORDER BY c.COL_NO`
const xuguLegacyListColumnsSQL = `
SELECT c.COL_NAME, c.TYPE_NAME, c.NOT_NULL, c.DEF_VAL, c.COMMENTS, c.SCALE, c."VARYING"
FROM ALL_COLUMNS c
JOIN ALL_TABLES t ON t.DB_ID = c.DB_ID AND t.TABLE_ID = c.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)
  AND (c.IS_HIDE IS NULL OR c.IS_HIDE = FALSE)
ORDER BY c.COL_NO`
const xuguListIndexesSQL = `
SELECT i.INDEX_NAME, i.KEYS, i.IS_UNIQUE, i.IS_PRIMARY, i.INDEX_TYPE, i.FILTER
FROM ALL_INDEXES i
JOIN ALL_TABLES t ON t.DB_ID = i.DB_ID AND t.TABLE_ID = i.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)
ORDER BY i.INDEX_NAME`
const xuguTableMetadataSQL = `
SELECT t.TEMP_TYPE, t.ON_COMMIT_DEL, t.PCTFREE, t.COPY_NUM,
       t.PARTI_TYPE, t.PARTI_NUM, t.PARTI_KEY,
       t.AUTO_PARTI_TYPE, t.AUTO_PARTI_SPAN,
       t.SUBPARTI_TYPE, t.SUBPARTI_NUM, t.SUBPARTI_KEY, t.COMMENTS
FROM ALL_TABLES t
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)`
const xuguTableIdentitySQL = `
SELECT c.COL_NAME, q.MIN_VAL, q.STEP_VAL
FROM ALL_COLUMNS c
JOIN ALL_TABLES t ON t.DB_ID = c.DB_ID AND t.TABLE_ID = c.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
JOIN ALL_SEQUENCES q ON q.DB_ID = c.DB_ID AND q.SEQ_ID = c.SERIAL_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)
  AND c.IS_SERIAL = TRUE`
const xuguTableConstraintsSQL = `
SELECT c.CONS_NAME, c.CONS_TYPE, c.DEFINE,
       rs.SCHEMA_NAME, rt.TABLE_NAME,
       c.MATCH_TYPE, c.UPDATE_ACTION, c.DELETE_ACTION,
       c.DEFERRABLE, c.INITDEFERRED, c.ENABLE
FROM ALL_CONSTRAINTS c
JOIN ALL_TABLES t ON t.DB_ID = c.DB_ID AND t.TABLE_ID = c.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
LEFT JOIN ALL_TABLES rt ON rt.DB_ID = c.DB_ID AND rt.TABLE_ID = c.REF_TABLE_ID
LEFT JOIN ALL_SCHEMAS rs ON rs.DB_ID = rt.DB_ID AND rs.SCHEMA_ID = rt.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)
ORDER BY c.CONS_NAME`
const xuguTablePartitionsSQL = `
SELECT p.PARTI_NAME, p.PARTI_VAL
FROM ALL_PARTIS p
JOIN ALL_TABLES t ON t.DB_ID = p.DB_ID AND t.TABLE_ID = p.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)
ORDER BY p.PARTI_NO`
const xuguTableSubpartitionsSQL = `
SELECT p.SUBPARTI_NAME, p.SUBPARTI_VAL
FROM ALL_SUBPARTIS p
JOIN ALL_TABLES t ON t.DB_ID = p.DB_ID AND t.TABLE_ID = p.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)
ORDER BY p.SUBPARTI_NO`

var xuguDataTypes = []string{
	"BOOLEAN",
	"INTEGER",
	"SMALLINT",
	"BIGINT",
	"FLOAT",
	"NUMERIC",
	"CHAR",
	"VARCHAR",
	"CLOB",
	"DATE",
	"TIME",
	"TIMESTAMP",
	"BINARY",
	"VARBINARY",
	"BLOB",
	"XML",
	"BOOL",
	"INT",
	"SHORT",
	"LONGINT",
	"LONG",
	"REAL",
	"DECIMAL",
	"TEXT",
	"NCHAR",
	"NVARCHAR",
	"NVARCHAR2",
}

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
	SysDBA           bool   `json:"sysdba"`
	URLParams        string `json:"url_params"`
	ConnectionString string `json:"connection_string"`
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

func (r queryResult) MarshalJSON() ([]byte, error) {
	type alias queryResult
	value := alias(r)
	if value.Columns == nil {
		value.Columns = []string{}
	}
	if value.ColumnTypes == nil {
		value.ColumnTypes = []string{}
	}
	if value.Rows == nil {
		value.Rows = [][]any{}
	}
	return json.Marshal(value)
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

func (r queryPageResult) MarshalJSON() ([]byte, error) {
	type alias queryPageResult
	value := alias(r)
	if value.Columns == nil {
		value.Columns = []string{}
	}
	if value.ColumnTypes == nil {
		value.ColumnTypes = []string{}
	}
	if value.Rows == nil {
		value.Rows = [][]any{}
	}
	return json.Marshal(value)
}

type querySession struct {
	rows        *sql.Rows
	columns     []string
	columnTypes []string
	pending     []any
	remaining   int
}

type databaseInfo struct {
	Name string `json:"name"`
}

type tableInfo struct {
	Name      string  `json:"name"`
	TableType string  `json:"table_type"`
	Comment   *string `json:"comment"`
}

type objectInfo struct {
	Name       string  `json:"name"`
	ObjectType string  `json:"object_type"`
	Schema     string  `json:"schema"`
	Comment    *string `json:"comment"`
	Valid      *bool   `json:"valid,omitempty"`
}

type metadataListConstraints struct {
	Filter      string
	Limit       int
	Offset      int
	ObjectTypes []string
}

type xuguMetadataListQuery struct {
	SQL  string
	Args []any
}

type columnInfo struct {
	Name                   string  `json:"name"`
	DataType               string  `json:"data_type"`
	IsNullable             bool    `json:"is_nullable"`
	ColumnDefault          *string `json:"column_default"`
	DefaultOnNull          int     `json:"default_on_null,omitempty"`
	IsPrimaryKey           bool    `json:"is_primary_key"`
	Extra                  *string `json:"extra"`
	Comment                *string `json:"comment"`
	NumericPrecision       *int    `json:"numeric_precision"`
	NumericScale           *int    `json:"numeric_scale"`
	CharacterMaximumLength *int    `json:"character_maximum_length"`
}

type indexInfo struct {
	Name            string   `json:"name"`
	Columns         []string `json:"columns"`
	IsUnique        bool     `json:"is_unique"`
	IsPrimary       bool     `json:"is_primary"`
	Filter          *string  `json:"filter"`
	IndexType       *string  `json:"index_type"`
	IncludedColumns []string `json:"included_columns"`
	Comment         *string  `json:"comment"`
}

func (i indexInfo) MarshalJSON() ([]byte, error) {
	type alias indexInfo
	value := alias(i)
	if value.Columns == nil {
		value.Columns = []string{}
	}
	if value.IncludedColumns == nil {
		value.IncludedColumns = []string{}
	}
	return json.Marshal(value)
}

type foreignKeyInfo struct {
	Name      string `json:"name"`
	Column    string `json:"column"`
	RefTable  string `json:"ref_table"`
	RefColumn string `json:"ref_column"`
}

// xuguTableMetadata mirrors the ALL_TABLES properties that affect a CREATE
// TABLE statement. Keeping this separate from tableInfo lets the object tree
// stay lightweight while the DDL exporter stays faithful to the catalog.
type xuguTableMetadata struct {
	TempType          int
	OnCommitDelete    bool
	PctFree           int
	CopyNum           int
	PartitionType     int
	PartitionCount    int
	PartitionKey      string
	AutoPartitionType int
	AutoPartitionSpan int
	SubpartitionType  int
	SubpartitionCount int
	SubpartitionKey   string
	Comment           string
}

type xuguIdentityInfo struct {
	Column string
	Start  int64
	Step   int64
}

type xuguConstraintInfo struct {
	Name              string
	Type              string
	Definition        string
	ReferenceSchema   string
	ReferenceTable    string
	MatchType         string
	UpdateAction      string
	DeleteAction      string
	Deferrable        bool
	InitiallyDeferred bool
	Enabled           bool
}

type xuguPartitionInfo struct {
	Name  string
	Value string
}

type triggerInfo struct {
	Name   string `json:"name"`
	Event  string `json:"event"`
	Timing string `json:"timing"`
}

type server struct {
	db                *sql.DB
	cancelDB          *sql.DB
	ownsCancelDB      bool
	params            connectParams
	nodeID            int
	databaseSessionID int64
	sessions          map[string]*querySession
	nextSessionID     int64
	activeCancelMu    sync.Mutex
	activeCancel      context.CancelFunc
	activeRows        map[*sql.Rows]context.CancelFunc
	activeTimer       *time.Timer
	activeTimedOut    bool
	// killSession, if non-nil, is called to force-kill the current
	// statement on the database server. Tests may replace it with a
	// stub. The real implementation is set during connectWithControl.
	killSession func()
}

type agentSession struct {
	server     *server
	controlKey string
	mu         sync.Mutex
}

type sharedControl struct {
	db   *sql.DB
	refs int
}

type runtimeServer struct {
	mu        sync.RWMutex
	sessions  map[string]*agentSession
	connectMu sync.Mutex
	controlMu sync.Mutex
	controls  map[string]*sharedControl
}

func main() {
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
		var requestEnvelope request
		if json.Unmarshal([]byte(line), &requestEnvelope) == nil && requestEnvelope.Method == "shutdown" {
			requests.Wait()
			resp, _ := runtime.handleLine(line)
			encoderMu.Lock()
			err := encoder.Encode(resp)
			encoderMu.Unlock()
			if err != nil {
				fmt.Fprintf(os.Stderr, "failed to write response: %v\n", err)
			}
			return
		}
		requests.Add(1)
		go func(line string) {
			defer requests.Done()
			resp, _ := runtime.handleLine(line)
			encoderMu.Lock()
			err := encoder.Encode(resp)
			encoderMu.Unlock()
			if err != nil {
				fmt.Fprintf(os.Stderr, "failed to write response: %v\n", err)
			}
		}(line)
	}
	requests.Wait()
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintf(os.Stderr, "failed to read stdin: %v\n", err)
	}
}

func newServer() *server {
	return &server{sessions: map[string]*querySession{}, activeRows: map[*sql.Rows]context.CancelFunc{}}
}

func newRuntimeServer() *runtimeServer {
	return &runtimeServer{sessions: map[string]*agentSession{}, controls: map[string]*sharedControl{}}
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
			"protocolVersion":      multiSessionProtocolVersion,
			"agentProtocolVersion": multiSessionProtocolVersion,
			"capabilities":         []string{"connect", "test_connection", "metadata", "query", "ddl", "multi_session"},
		}, false, nil
	case "open_session":
		agentSessionID := stringParam(params, "agentSessionId")
		if agentSessionID == "" {
			return nil, false, errors.New("agentSessionId is required")
		}
		var cp connectParams
		if err := decodeParams(params, &cp); err != nil {
			return nil, false, err
		}
		return map[string]bool{"ok": true}, false, r.openSession(agentSessionID, cp)
	case "close_session":
		return map[string]bool{"ok": true}, false, r.closeSession(stringParam(params, "agentSessionId"))
	case "validate_session":
		agentSessionID := stringParam(params, "agentSessionId")
		session, err := r.session(agentSessionID)
		if err != nil {
			return nil, false, err
		}
		session.mu.Lock()
		defer session.mu.Unlock()
		if err := session.server.validateConnection(); err == nil {
			return map[string]bool{"ok": true}, false, nil
		}
		r.connectMu.Lock()
		err = session.server.connectWithControl(session.server.params, session.server.cancelDB, false)
		r.connectMu.Unlock()
		return map[string]bool{"ok": true}, false, err
	case "cancel_session":
		session, err := r.session(stringParam(params, "agentSessionId"))
		if err != nil {
			return nil, false, err
		}
		session.server.cancelActiveQuery()
		return map[string]bool{"ok": true}, false, nil
	case "test_connection":
		return newServer().dispatch(method, params)
	case "shutdown":
		return map[string]bool{"ok": true}, true, r.closeAllSessions()
	case "connect":
		var cp connectParams
		if err := decodeParams(params, &cp); err != nil {
			return nil, false, err
		}
		return map[string]bool{"ok": true}, false, r.replaceSession(legacyAgentSessionID, cp)
	case "disconnect":
		return map[string]bool{"ok": true}, false, r.closeSession(legacyAgentSessionID)
	default:
		agentSessionID := stringParam(params, "agentSessionId")
		if agentSessionID == "" {
			agentSessionID = legacyAgentSessionID
		}
		return r.withSession(agentSessionID, method, params)
	}
}

func (r *runtimeServer) withSession(agentSessionID, method string, params map[string]json.RawMessage) (any, bool, error) {
	session, err := r.session(agentSessionID)
	if err != nil {
		return nil, false, err
	}
	// Database, schema, transaction, and cursor state are connection-scoped.
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.server.dispatch(method, params)
}

func (r *runtimeServer) openSession(agentSessionID string, params connectParams) error {
	r.mu.Lock()
	if _, exists := r.sessions[agentSessionID]; exists {
		r.mu.Unlock()
		return fmt.Errorf("agent session already exists: %s", agentSessionID)
	}
	if len(r.sessions) >= maxAgentSessions {
		r.mu.Unlock()
		return fmt.Errorf("agent session limit reached: %d", maxAgentSessions)
	}
	r.mu.Unlock()

	server := newServer()
	params.URLParams = appendURLParam(params.URLParams, "APP_NAME", xuguSessionAppName(agentSessionID))
	r.connectMu.Lock()
	controlKey, controlDB, err := r.acquireControl(params)
	if err == nil {
		err = server.connectWithControl(params, controlDB, false)
	}
	r.connectMu.Unlock()
	if err != nil {
		if controlKey != "" {
			r.releaseControl(controlKey)
		}
		return err
	}
	session := &agentSession{server: server, controlKey: controlKey}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.sessions[agentSessionID]; exists {
		_ = server.disconnect()
		r.releaseControl(controlKey)
		return fmt.Errorf("agent session already exists: %s", agentSessionID)
	}
	if len(r.sessions) >= maxAgentSessions {
		_ = server.disconnect()
		r.releaseControl(controlKey)
		return fmt.Errorf("agent session limit reached: %d", maxAgentSessions)
	}
	r.sessions[agentSessionID] = session
	return nil
}

func (r *runtimeServer) replaceSession(agentSessionID string, params connectParams) error {
	_ = r.closeSession(agentSessionID)
	return r.openSession(agentSessionID, params)
}

func (r *runtimeServer) session(agentSessionID string) (*agentSession, error) {
	r.mu.RLock()
	session := r.sessions[agentSessionID]
	r.mu.RUnlock()
	if session == nil {
		return nil, fmt.Errorf("agent session not found: %s", agentSessionID)
	}
	return session, nil
}

func (r *runtimeServer) closeSession(agentSessionID string) error {
	r.mu.Lock()
	session := r.sessions[agentSessionID]
	delete(r.sessions, agentSessionID)
	r.mu.Unlock()
	if session == nil {
		return nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	err := session.server.disconnect()
	r.releaseControl(session.controlKey)
	return err
}

func (r *runtimeServer) acquireControl(params connectParams) (string, *sql.DB, error) {
	r.controlMu.Lock()
	defer r.controlMu.Unlock()
	cancelParams := xuguControlParams(params)
	key := buildDSN(cancelParams)
	if control := r.controls[key]; control != nil {
		control.refs++
		return key, control.db, nil
	}
	db, err := openDB(cancelParams)
	if err != nil {
		return "", nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return "", nil, err
	}
	r.controls[key] = &sharedControl{db: db, refs: 1}
	return key, db, nil
}

func (r *runtimeServer) releaseControl(key string) {
	if key == "" {
		return
	}
	r.controlMu.Lock()
	defer r.controlMu.Unlock()
	control := r.controls[key]
	if control == nil {
		return
	}
	control.refs--
	if control.refs <= 0 {
		_ = control.db.Close()
		delete(r.controls, key)
	}
}

func (r *runtimeServer) closeAllSessions() error {
	r.mu.Lock()
	ids := make([]string, 0, len(r.sessions))
	for id := range r.sessions {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	var firstErr error
	for _, id := range ids {
		if err := r.closeSession(id); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s *server) handleLine(line string) (response, bool) {
	var req request
	if err := json.Unmarshal([]byte(line), &req); err != nil {
		return errorResponse(nil, err), false
	}
	if len(req.ID) == 0 {
		req.ID = json.RawMessage("1")
	}
	result, shutdown, err := s.dispatch(req.Method, req.Params)
	if err != nil {
		return errorResponse(req.ID, err), false
	}
	return response{JSONRPC: "2.0", ID: req.ID, Result: result}, shutdown
}

func (s *server) dispatch(method string, params map[string]json.RawMessage) (any, bool, error) {
	switch method {
	case "handshake":
		return map[string]any{
			"protocolVersion":      protocolVersion,
			"agentProtocolVersion": protocolVersion,
			"capabilities":         []string{"connect", "test_connection", "metadata", "query", "ddl"},
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
		db, err := openDB(cp)
		if err != nil {
			return nil, false, err
		}
		defer db.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			return nil, false, err
		}
		return map[string]bool{"ok": true}, false, nil
	case "validate_connection":
		return map[string]bool{"ok": true}, false, s.validateConnection()
	case "list_databases":
		result, err := s.listDatabases()
		return result, false, err
	case "list_schemas":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		result, err := s.listSchemas()
		return result, false, err
	case "list_tables":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		schema := stringParam(params, "schema")
		result, err := s.listTables(schema, metadataListConstraintsFromParams(params))
		return result, false, err
	case "list_objects":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		schema := stringParam(params, "schema")
		result, err := s.listObjects(schema, metadataListConstraintsFromParams(params))
		return result, false, err
	case "list_data_types":
		return xuguDataTypes, false, nil
	case "get_columns":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		schema := stringParam(params, "schema")
		table := stringParam(params, "table")
		result, err := s.getColumns(schema, table)
		return result, false, err
	case "get_object_source":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		schema := stringParam(params, "schema")
		name := stringParam(params, "name")
		objectType := stringParam(params, "object_type")
		source, err := s.getObjectSource(schema, name, objectType)
		return source, false, err
	case "get_table_ddl":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		schema := stringParam(params, "schema")
		table := stringParam(params, "table")
		ddl, err := s.getTableDDL(schema, table)
		return ddl, false, err
	case "execute_query":
		var opts queryOptions
		if err := decodeParams(params, &opts); err != nil {
			return nil, false, err
		}
		result, err := s.executeQuery(opts)
		return result, false, err
	case "execute_query_page":
		var opts queryOptions
		if err := decodeParams(params, &opts); err != nil {
			return nil, false, err
		}
		result, err := s.executeQueryPage(opts, intParam(params, "pageSize"))
		return result, false, err
	case "fetch_query_page":
		result, err := s.fetchQueryPage(stringParam(params, "sessionId"), intParam(params, "pageSize"))
		return result, false, err
	case "close_query_session":
		return s.closeQuerySession(stringParam(params, "sessionId")), false, nil
	case "start_table_read":
		var opts queryOptions
		if err := decodeParams(params, &opts); err != nil {
			return nil, false, err
		}
		result, err := s.executeQueryPage(opts, intParam(params, "pageSize"))
		return result, false, err
	case "fetch_table_read_page":
		result, err := s.fetchQueryPage(stringParam(params, "sessionId"), intParam(params, "pageSize"))
		return result, false, err
	case "close_table_read_session":
		return s.closeQuerySession(stringParam(params, "sessionId")), false, nil
	case "list_indexes":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		schema := stringParam(params, "schema")
		table := stringParam(params, "table")
		result, err := s.listIndexes(schema, table)
		return result, false, err
	case "list_foreign_keys":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		schema := stringParam(params, "schema")
		table := stringParam(params, "table")
		result, err := s.listForeignKeys(schema, table)
		return result, false, err
	case "list_triggers":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		schema := stringParam(params, "schema")
		table := stringParam(params, "table")
		result, err := s.listTriggers(schema, table)
		return result, false, err
	case "get_explain_info":
		sqlText := stringParam(params, "sql")
		plan, err := s.getExplainInfo(sqlText)
		return map[string]any{"plan": plan, "has_actual_stats": false}, false, err
	case "execute_transaction":
		result, err := s.executeTransaction(params)
		return result, false, err
	case "disconnect":
		return map[string]bool{"ok": true}, false, s.disconnect()
	case "shutdown":
		_ = s.disconnect()
		return map[string]bool{"ok": true}, true, nil
	default:
		return nil, false, fmt.Errorf("unknown method: %s", method)
	}
}

func (s *server) connect(params connectParams) error {
	cancelParams := xuguControlParams(params)
	cancelDB, err := openDB(cancelParams)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := cancelDB.PingContext(ctx); err != nil {
		cancelDB.Close()
		return err
	}
	if err := s.connectWithControl(params, cancelDB, true); err != nil {
		cancelDB.Close()
		return err
	}
	return nil
}

func (s *server) connectWithControl(params connectParams, cancelDB *sql.DB, ownsCancelDB bool) error {
	_ = s.disconnect()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	before, err := xuguDatabaseSessions(cancelDB)
	if err != nil {
		return err
	}
	db, err := openDB(params)
	if err != nil {
		return err
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return err
	}
	after, err := xuguDatabaseSessions(cancelDB)
	if err != nil {
		db.Close()
		return err
	}
	databaseSession, err := newXuguDatabaseSession(before, after)
	if err != nil {
		db.Close()
		return err
	}
	s.db = db
	s.cancelDB = cancelDB
	s.ownsCancelDB = ownsCancelDB
	s.params = params
	s.nodeID = databaseSession.nodeID
	s.databaseSessionID = databaseSession.sessionID
	s.killSession = func() {
		if s.cancelDB != nil && s.databaseSessionID > 0 {
			_, _ = s.cancelDB.Exec(fmt.Sprintf("CALL DBMS_DBA.KILL_SESSION_TRANS(%d, %d)", s.nodeID, s.databaseSessionID))
		}
	}
	return nil
}

func (s *server) disconnect() error {
	s.cancelActiveQuery()
	s.closeAllQuerySessions()
	if s.ownsCancelDB && s.cancelDB != nil {
		_ = s.cancelDB.Close()
	}
	if s.db == nil {
		return nil
	}
	err := s.db.Close()
	s.db = nil
	s.cancelDB = nil
	s.ownsCancelDB = false
	s.nodeID = 0
	s.databaseSessionID = 0
	s.killSession = nil
	return err
}

func (s *server) validateConnection() error {
	if s.db == nil {
		return errors.New("not connected")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.db.PingContext(ctx)
}

func openDB(params connectParams) (*sql.DB, error) {
	dsn := buildDSN(params)
	db, err := sql.Open("xugu", dsn)
	if err != nil {
		return nil, err
	}
	// One logical Agent session must map to exactly one server-side session so
	// schema, transaction, cursor, and cancellation state stay deterministic.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(30 * time.Minute)
	return db, nil
}

func appendURLParam(raw, key, value string) string {
	parts := make([]string, 0, 2)
	for _, part := range strings.Split(raw, ";") {
		part = strings.TrimSpace(part)
		if part != "" && !strings.HasPrefix(strings.ToUpper(part), strings.ToUpper(key)+"=") {
			parts = append(parts, part)
		}
	}
	parts = append(parts, key+"="+value)
	return strings.Join(parts, ";")
}

func xuguSessionAppName(agentSessionID string) string {
	digest := sha256.Sum256([]byte(agentSessionID))
	return fmt.Sprintf("DBX_%x", digest[:8])
}

func xuguControlParams(params connectParams) connectParams {
	params.Database = "SYSTEM"
	params.ConnectionString = ""
	params.URLParams = appendURLParam(params.URLParams, "APP_NAME", "DBX_CONTROL")
	return params
}

type xuguDatabaseSession struct {
	nodeID    int
	sessionID int64
}

func xuguDatabaseSessions(db *sql.DB) (map[xuguDatabaseSession]struct{}, error) {
	rows, err := db.Query("SELECT NODEID, SESSION_ID FROM SYS_SESSIONS")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[xuguDatabaseSession]struct{}{}
	for rows.Next() {
		var session xuguDatabaseSession
		if err := rows.Scan(&session.nodeID, &session.sessionID); err != nil {
			return nil, err
		}
		result[session] = struct{}{}
	}
	return result, rows.Err()
}

func newXuguDatabaseSession(
	before map[xuguDatabaseSession]struct{},
	after map[xuguDatabaseSession]struct{},
) (xuguDatabaseSession, error) {
	var candidates []xuguDatabaseSession
	for session := range after {
		if _, existed := before[session]; !existed {
			candidates = append(candidates, session)
		}
	}
	if len(candidates) != 1 {
		return xuguDatabaseSession{}, fmt.Errorf("failed to identify Xugu server session: found %d new sessions", len(candidates))
	}
	return candidates[0], nil
}

func buildDSN(params connectParams) string {
	connectionString := strings.TrimSpace(params.ConnectionString)
	if looksLikeXuguDSN(connectionString) {
		return connectionString
	}
	if parsed := parseXuguURL(connectionString); parsed.Host != "" {
		if parsed.Database == "" {
			parsed.Database = params.Database
		}
		if parsed.Username == "" {
			parsed.Username = params.Username
		}
		if parsed.Password == "" {
			parsed.Password = params.Password
		}
		return buildXuguDSN(parsed.Host, parsed.Port, parsed.Database, parsed.Username, parsed.Password, params.URLParams)
	}

	if jdbc := parseXuguJDBCURL(connectionString); jdbc.Host != "" {
		return buildXuguDSN(jdbc.Host, jdbc.Port, jdbc.Database, params.Username, params.Password, params.URLParams)
	}

	return buildXuguDSN(params.Host, params.Port, params.Database, params.Username, params.Password, params.URLParams)
}

func looksLikeXuguDSN(value string) bool {
	upper := strings.ToUpper(value)
	return strings.Contains(upper, "IP=") && strings.Contains(upper, "DB=") && strings.Contains(upper, "USER=")
}

type xuguURLInfo struct {
	Host     string
	Port     int
	Database string
	Username string
	Password string
}

var xuguJDBCRegexp = regexp.MustCompile(`(?i)^jdbc:xugu://([^/:]+)(?::([0-9]+))?/([^?;]+)`)

func parseXuguJDBCURL(value string) xuguURLInfo {
	value = strings.TrimSpace(value)
	match := xuguJDBCRegexp.FindStringSubmatch(value)
	if len(match) != 4 {
		return xuguURLInfo{}
	}
	return xuguURLInfo{Host: match[1], Port: parsePort(match[2]), Database: match[3]}
}

func parseXuguURL(value string) xuguURLInfo {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(strings.ToLower(value), "xugu://") {
		return xuguURLInfo{}
	}
	withoutScheme := value[len("xugu://"):]
	var userInfo string
	hostPart := withoutScheme
	if at := strings.LastIndex(hostPart, "@"); at >= 0 {
		userInfo = hostPart[:at]
		hostPart = hostPart[at+1:]
	}
	if slash := strings.IndexAny(hostPart, "/?"); slash >= 0 {
		databasePart := strings.TrimLeft(hostPart[slash:], "/")
		hostPart = hostPart[:slash]
		if q := strings.Index(databasePart, "?"); q >= 0 {
			databasePart = databasePart[:q]
		}
		info := parseHostPort(hostPart)
		info.Database = databasePart
		if userInfo != "" {
			info.Username, info.Password = splitUserInfo(userInfo)
		}
		return info
	}
	info := parseHostPort(hostPart)
	if userInfo != "" {
		info.Username, info.Password = splitUserInfo(userInfo)
	}
	return info
}

func parseHostPort(value string) xuguURLInfo {
	host := strings.TrimSpace(value)
	port := 0
	if idx := strings.LastIndex(host, ":"); idx > 0 {
		port = parsePort(host[idx+1:])
		host = host[:idx]
	}
	return xuguURLInfo{Host: host, Port: port}
}

func splitUserInfo(value string) (string, string) {
	if idx := strings.Index(value, ":"); idx >= 0 {
		return value[:idx], value[idx+1:]
	}
	return value, ""
}

func buildXuguDSN(host string, port int, database, username, password, urlParams string) string {
	if port <= 0 {
		port = defaultXuguPort
	}
	parts := []string{
		"IP=" + host,
		"DB=" + strings.TrimSpace(database),
		"User=" + strings.TrimSpace(username),
		"PWD=" + strings.TrimSpace(password),
		"Port=" + strconv.Itoa(port),
	}
	if !hasDSNParam(urlParams, "CHAR_SET") && !hasDSNParam(urlParams, "CHARSET") {
		parts = append(parts, "CHAR_SET=UTF8")
	}
	for _, param := range splitDSNParams(urlParams) {
		parts = append(parts, param)
	}
	return strings.Join(parts, ";")
}

func hasDSNParam(raw, key string) bool {
	key = strings.ToUpper(strings.TrimSpace(key))
	for _, param := range splitDSNParams(raw) {
		name, _, _ := strings.Cut(param, "=")
		if strings.ToUpper(strings.TrimSpace(name)) == key {
			return true
		}
	}
	return false
}

func splitDSNParams(raw string) []string {
	raw = strings.TrimSpace(strings.Trim(raw, ";"))
	if raw == "" {
		return nil
	}
	if strings.Contains(raw, ";") {
		items := strings.Split(raw, ";")
		result := make([]string, 0, len(items))
		for _, item := range items {
			item = strings.TrimSpace(item)
			if item != "" {
				result = append(result, item)
			}
		}
		return result
	}
	if strings.Contains(raw, "&") {
		items := strings.Split(raw, "&")
		result := make([]string, 0, len(items))
		for _, item := range items {
			item = strings.TrimSpace(item)
			if item != "" {
				result = append(result, item)
			}
		}
		return result
	}
	return []string{raw}
}

func parsePort(value string) int {
	port, _ := strconv.Atoi(value)
	return port
}

func (s *server) requireDB() (*sql.DB, error) {
	if s.db == nil {
		return nil, errors.New("agent is not connected")
	}
	return s.db, nil
}

func (s *server) useDatabase(database string) error {
	database = strings.TrimSpace(database)
	if database == "" {
		return nil
	}
	if strings.EqualFold(database, configuredDatabaseName(s.params)) {
		return nil
	}
	db, err := s.requireDB()
	if err != nil {
		return err
	}
	_, err = db.Exec("USE " + quoteIdentifier(database))
	return err
}

func (s *server) listDatabases() ([]databaseInfo, error) {
	rows, err := s.queryRows(xuguListDatabasesSQL, nil)
	if err != nil {
		if fallback := fallbackDatabasesFromParams(s.params); len(fallback) > 0 && isXuguMetadataAccessError(err) {
			return fallback, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)
	var result []databaseInfo
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		result = append(result, databaseInfo{Name: name})
	}
	return emptyIfNil(result), rows.Err()
}

func fallbackDatabasesFromParams(params connectParams) []databaseInfo {
	if name := configuredDatabaseName(params); name != "" {
		return []databaseInfo{{Name: name}}
	}
	return nil
}

func configuredDatabaseName(params connectParams) string {
	if name := strings.TrimSpace(params.Database); name != "" {
		return name
	}
	connectionString := strings.TrimSpace(params.ConnectionString)
	if parsed := parseXuguURL(connectionString); parsed.Database != "" {
		return parsed.Database
	}
	if jdbc := parseXuguJDBCURL(connectionString); jdbc.Database != "" {
		return jdbc.Database
	}
	if value := xuguDSNValue(connectionString, "DB"); value != "" {
		return value
	}
	return ""
}

func isXuguMetadataAccessError(err error) bool {
	message := strings.ToUpper(err.Error())
	return strings.Contains(message, "E18012") ||
		strings.Contains(message, "权限不够") ||
		strings.Contains(message, "ALL_DATABASES") ||
		strings.Contains(message, "SYS_DATABASES") ||
		strings.Contains(message, "ALL_SCHEMAS") ||
		strings.Contains(message, "SYS_SCHEMAS") ||
		strings.Contains(message, "ALL_TABLES") ||
		strings.Contains(message, "SYS_TABLES") ||
		strings.Contains(message, "ALL_VIEWS") ||
		strings.Contains(message, "SYS_VIEWS") ||
		strings.Contains(message, "ALL_COLUMNS") ||
		strings.Contains(message, "ALL_CONSTRAINTS") ||
		strings.Contains(message, "ALL_INDEXES") ||
		strings.Contains(message, "SYS_COLUMNS") ||
		strings.Contains(message, "SYS_CONSTRAINTS") ||
		strings.Contains(message, "SYS_INDEXES") ||
		strings.Contains(message, "SYS_TRIGGERS")
}

func isXuguMissingOnNullColumnError(err error) bool {
	message := strings.ToUpper(strings.TrimSpace(strings.TrimRight(err.Error(), "\x00")))
	if !strings.Contains(message, "ON_NULL") {
		return false
	}
	return strings.Contains(message, "E10049") ||
		strings.Contains(message, "不存在") ||
		strings.Contains(message, "DOES NOT EXIST") ||
		strings.Contains(message, "UNKNOWN COLUMN")
}

func xuguDSNValue(dsn string, key string) string {
	for _, part := range strings.Split(dsn, ";") {
		name, value, ok := strings.Cut(part, "=")
		if ok && strings.EqualFold(strings.TrimSpace(name), key) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (s *server) listSchemas() ([]string, error) {
	rows, err := s.queryRows(xuguListSchemasSQL, nil)
	if err != nil {
		if fallback := strings.ToUpper(strings.TrimSpace(s.params.Username)); fallback != "" && isXuguMetadataAccessError(err) {
			return []string{fallback}, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)
	var result []string
	for rows.Next() {
		var schema string
		if err := rows.Scan(&schema); err != nil {
			return nil, err
		}
		result = append(result, schema)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) currentSchema() (string, error) {
	rows, err := s.queryRows(`
SELECT s.SCHEMA_NAME
FROM SYS_SCHEMAS s
JOIN SYS_USERS u ON u.DB_ID = s.DB_ID AND u.USER_ID = s.USER_ID
WHERE UPPER(u.USER_NAME) = UPPER(?)
ORDER BY CASE WHEN UPPER(s.SCHEMA_NAME) = UPPER(?) THEN 0 ELSE 1 END, s.SCHEMA_NAME`, []any{s.params.Username, s.params.Username})
	if err != nil {
		if fallback := strings.ToUpper(strings.TrimSpace(s.params.Username)); fallback != "" && isXuguMetadataAccessError(err) {
			return fallback, nil
		}
		return "", err
	}
	defer s.closeRows(rows)
	if rows.Next() {
		var schema string
		if err := rows.Scan(&schema); err != nil {
			return "", err
		}
		return strings.ToUpper(schema), nil
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return strings.ToUpper(strings.TrimSpace(s.params.Username)), nil
}

func (s *server) normalizeSchema(schema string) (string, error) {
	schema = strings.TrimSpace(schema)
	if schema == "" {
		return s.currentSchema()
	}
	return strings.ToUpper(schema), nil
}

func (s *server) listTables(schema string, constraints metadataListConstraints) ([]tableInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	query := xuguListTablesQuery(schema, constraints)
	rows, err := s.queryRows(query.SQL, query.Args)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var result []tableInfo
	for rows.Next() {
		var item tableInfo
		if err := rows.Scan(&item.Name, &item.TableType, &item.Comment); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) listObjects(schema string, constraints metadataListConstraints) ([]objectInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	query := xuguListObjectsQuery(schema, constraints)
	rows, err := s.queryRows(query.SQL, query.Args)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var result []objectInfo
	for rows.Next() {
		var item objectInfo
		var valid any
		item.Schema = schema
		if err := rows.Scan(&item.Name, &item.ObjectType, &item.Comment, &valid); err != nil {
			return nil, err
		}
		if valid != nil {
			value := truthy(valid)
			item.Valid = &value
		}
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func metadataListConstraintsFromParams(params map[string]json.RawMessage) metadataListConstraints {
	objectTypes := stringSliceParam(params, "object_types")
	if len(objectTypes) == 0 {
		objectTypes = stringSliceParam(params, "objectTypes")
	}
	limit := intParam(params, "limit")
	offset := intParam(params, "offset")
	if limit < 0 {
		limit = 0
	}
	if offset < 0 {
		offset = 0
	}
	return metadataListConstraints{
		Filter:      stringParam(params, "filter"),
		Limit:       limit,
		Offset:      offset,
		ObjectTypes: objectTypes,
	}
}

func xuguListTablesQuery(schema string, constraints metadataListConstraints) xuguMetadataListQuery {
	return xuguConstrainedMetadataListQuery(
		`
SELECT t.TABLE_NAME, 'TABLE' AS TABLE_TYPE, t.COMMENTS
FROM ALL_TABLES t
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
UNION ALL
SELECT v.VIEW_NAME, 'VIEW' AS TABLE_TYPE, v.COMMENTS
FROM ALL_VIEWS v
JOIN ALL_SCHEMAS s ON s.DB_ID = v.DB_ID AND s.SCHEMA_ID = v.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)`,
		"TABLE_NAME, TABLE_TYPE, COMMENTS",
		"TABLE_NAME",
		"TABLE_TYPE",
		[]any{schema, schema},
		constraints,
	)
}

func xuguListObjectsQuery(schema string, constraints metadataListConstraints) xuguMetadataListQuery {
	return xuguConstrainedMetadataListQuery(
		`
SELECT t.TABLE_NAME AS OBJECT_NAME, 'TABLE' AS OBJECT_TYPE, t.COMMENTS, NULL AS VALID
FROM ALL_TABLES t
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
UNION ALL
SELECT v.VIEW_NAME AS OBJECT_NAME, 'VIEW' AS OBJECT_TYPE, v.COMMENTS, NULL AS VALID
FROM ALL_VIEWS v
JOIN ALL_SCHEMAS s ON s.DB_ID = v.DB_ID AND s.SCHEMA_ID = v.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
UNION ALL
SELECT p.PROC_NAME AS OBJECT_NAME,
       CASE WHEN p.RET_TYPE IS NULL THEN 'PROCEDURE' ELSE 'FUNCTION' END AS OBJECT_TYPE,
       p.COMMENTS, p.VALID
FROM ALL_PROCEDURES p
JOIN ALL_SCHEMAS s ON s.DB_ID = p.DB_ID AND s.SCHEMA_ID = p.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
UNION ALL
SELECT p.PACK_NAME AS OBJECT_NAME, 'PACKAGE' AS OBJECT_TYPE, p.COMMENTS, p.VALID
FROM ALL_PACKAGES p
JOIN ALL_SCHEMAS s ON s.DB_ID = p.DB_ID AND s.SCHEMA_ID = p.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
UNION ALL
SELECT p.PACK_NAME AS OBJECT_NAME, 'PACKAGE_BODY' AS OBJECT_TYPE, p.COMMENTS, p.ALL_OK
FROM ALL_PACKAGES p
JOIN ALL_SCHEMAS s ON s.DB_ID = p.DB_ID AND s.SCHEMA_ID = p.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND p.BODY IS NOT NULL
UNION ALL
SELECT tr.TRIG_NAME AS OBJECT_NAME, 'TRIGGER' AS OBJECT_TYPE, tr.COMMENTS, tr.VALID
FROM ALL_TRIGGERS tr
JOIN ALL_SCHEMAS s ON s.DB_ID = tr.DB_ID AND s.SCHEMA_ID = tr.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
UNION ALL
SELECT q.SEQ_NAME AS OBJECT_NAME, 'SEQUENCE' AS OBJECT_TYPE, NULL AS COMMENTS, NULL AS VALID
FROM ALL_SEQUENCES q
JOIN ALL_SCHEMAS s ON s.DB_ID = q.DB_ID AND s.SCHEMA_ID = q.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
UNION ALL
SELECT u.TYPE_NAME AS OBJECT_NAME, 'TYPE' AS OBJECT_TYPE, u.COMMENTS, u.VALID
FROM ALL_TYPES u
JOIN ALL_SCHEMAS s ON s.DB_ID = u.DB_ID AND s.SCHEMA_ID = u.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
UNION ALL
SELECT u.TYPE_NAME AS OBJECT_NAME, 'TYPE_BODY' AS OBJECT_TYPE, u.COMMENTS, u.VALID
FROM ALL_TYPES u
JOIN ALL_SCHEMAS s ON s.DB_ID = u.DB_ID AND s.SCHEMA_ID = u.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND u.BODY IS NOT NULL`,
		"OBJECT_NAME, OBJECT_TYPE, COMMENTS, VALID",
		"OBJECT_NAME",
		"OBJECT_TYPE",
		[]any{schema, schema, schema, schema, schema, schema, schema, schema, schema},
		constraints,
	)
}

func xuguConstrainedMetadataListQuery(baseSQL, selectList, nameColumn, typeColumn string, baseArgs []any, constraints metadataListConstraints) xuguMetadataListQuery {
	args := append([]any{}, baseArgs...)
	where := make([]string, 0, 2)
	if filter := strings.TrimSpace(constraints.Filter); filter != "" {
		args = append(args, strings.ToUpper(xuguFuzzyLikePattern(filter)))
		where = append(where, fmt.Sprintf("UPPER(%s) LIKE ? ESCAPE '\\'", nameColumn))
	}
	if len(constraints.ObjectTypes) > 0 {
		objectTypes := normalizedXuguObjectTypes(constraints.ObjectTypes)
		if len(objectTypes) == 0 {
			where = append(where, "1 = 0")
		} else {
			placeholders := make([]string, 0, len(objectTypes))
			for _, objectType := range objectTypes {
				args = append(args, objectType)
				placeholders = append(placeholders, "?")
			}
			where = append(where, fmt.Sprintf("%s IN (%s)", typeColumn, strings.Join(placeholders, ",")))
		}
	}

	sqlText := fmt.Sprintf("SELECT %s\nFROM (\n%s\n)", selectList, baseSQL)
	if len(where) > 0 {
		sqlText += "\nWHERE " + strings.Join(where, " AND ")
	}
	sqlText += fmt.Sprintf("\nORDER BY %s, %s", typeColumn, nameColumn)

	// Xugu documents ROWNUM as the safe pagination path when ORDER BY belongs
	// to an inner query; LIMIT is not portable for this UNION metadata query.
	if constraints.Limit > 0 {
		args = append(args, constraints.Offset+constraints.Limit, constraints.Offset)
		sqlText = fmt.Sprintf(
			"SELECT %s\nFROM (\n  SELECT DBX_Q.*, ROWNUM AS DBX_RN\n  FROM (\n%s\n  ) DBX_Q\n  WHERE ROWNUM <= ?\n)\nWHERE DBX_RN > ?",
			selectList,
			sqlText,
		)
	} else if constraints.Offset > 0 {
		args = append(args, constraints.Offset)
		sqlText = fmt.Sprintf(
			"SELECT %s\nFROM (\n  SELECT DBX_Q.*, ROWNUM AS DBX_RN\n  FROM (\n%s\n  ) DBX_Q\n)\nWHERE DBX_RN > ?",
			selectList,
			sqlText,
		)
	}

	return xuguMetadataListQuery{SQL: sqlText, Args: args}
}

func normalizedXuguObjectTypes(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		normalized := strings.ToUpper(strings.TrimSpace(value))
		normalized = strings.ReplaceAll(normalized, "-", "_")
		normalized = strings.ReplaceAll(normalized, " ", "_")
		switch normalized {
		case "TABLE", "BASE_TABLE":
			normalized = "TABLE"
		case "VIEW":
			normalized = "VIEW"
		case "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY":
			// Already normalized.
		default:
			continue
		}
		if seen[normalized] {
			continue
		}
		seen[normalized] = true
		result = append(result, normalized)
	}
	sort.Strings(result)
	return result
}

func xuguFuzzyLikePattern(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "%%"
	}
	var builder strings.Builder
	builder.Grow(len(value)*2 + 2)
	builder.WriteByte('%')
	for _, ch := range value {
		switch ch {
		case '\\', '%', '_':
			builder.WriteByte('\\')
		}
		builder.WriteRune(ch)
		builder.WriteByte('%')
	}
	return builder.String()
}

func (s *server) getColumns(schema, table string) ([]columnInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	table = strings.ToUpper(strings.TrimSpace(table))
	primaryKeys, err := s.primaryKeyColumns(schema, table)
	if err != nil {
		return nil, err
	}
	rows, hasDefaultOnNull, err := s.queryColumnRows(schema, table)
	if err != nil {
		if isXuguMetadataAccessError(err) {
			return s.columnsFromSelect(schema, table, primaryKeys)
		}
		return nil, err
	}
	defer s.closeRows(rows)
	var result []columnInfo
	for rows.Next() {
		var item columnInfo
		var notNull any
		var onNull any
		var scale *int
		var varying any
		destinations := []any{&item.Name, &item.DataType, &notNull, &item.ColumnDefault}
		if hasDefaultOnNull {
			destinations = append(destinations, &onNull)
		}
		destinations = append(destinations, &item.Comment, &scale, &varying)
		if err := rows.Scan(destinations...); err != nil {
			return nil, err
		}
		item.DataType = normalizeXuguColumnType(item.DataType, varying)
		item.IsNullable = !truthy(notNull)
		item.DefaultOnNull = xuguInt(onNull)
		item.IsPrimaryKey = primaryKeys[strings.ToUpper(item.Name)]
		item.NumericPrecision, item.NumericScale, item.CharacterMaximumLength = decodeXuguScale(item.DataType, scale)
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) queryColumnRows(schema, table string) (*sql.Rows, bool, error) {
	args := []any{schema, table}
	rows, err := s.queryRows(xuguListColumnsSQL, args)
	if err == nil {
		return rows, true, nil
	}
	if !isXuguMissingOnNullColumnError(err) {
		return nil, false, err
	}
	rows, err = s.queryRows(xuguLegacyListColumnsSQL, args)
	return rows, false, err
}

func (s *server) columnsFromSelect(schema, table string, primaryKeys map[string]bool) ([]columnInfo, error) {
	rows, err := s.queryRows(
		"SELECT * FROM "+quoteIdentifier(schema)+"."+quoteIdentifier(table)+" WHERE 1 = 0",
		nil,
	)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	result := make([]columnInfo, 0, len(types))
	for _, columnType := range types {
		item := columnInfo{
			Name:         columnType.Name(),
			DataType:     columnType.DatabaseTypeName(),
			IsPrimaryKey: primaryKeys[strings.ToUpper(columnType.Name())],
		}
		if nullable, ok := columnType.Nullable(); ok {
			item.IsNullable = nullable
		} else {
			item.IsNullable = true
		}
		if length, ok := columnType.Length(); ok {
			value := int(length)
			item.CharacterMaximumLength = &value
		}
		result = append(result, item)
	}
	return emptyIfNil(result), nil
}

func (s *server) primaryKeyColumns(schema, table string) (map[string]bool, error) {
	rows, err := s.queryRows(xuguPrimaryKeyColumnsSQL, []any{schema, table})
	if err != nil {
		if isXuguMetadataAccessError(err) {
			return map[string]bool{}, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)
	result := map[string]bool{}
	for rows.Next() {
		var define string
		if err := rows.Scan(&define); err != nil {
			return nil, err
		}
		for _, column := range parseQuotedIdentifiers(define) {
			result[strings.ToUpper(column)] = true
		}
	}
	return result, rows.Err()
}

func (s *server) listIndexes(schema, table string) ([]indexInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	table = strings.ToUpper(strings.TrimSpace(table))
	rows, err := s.queryRows(xuguListIndexesSQL, []any{schema, table})
	if err != nil {
		if isXuguMetadataAccessError(err) {
			return []indexInfo{}, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)

	var result []indexInfo
	for rows.Next() {
		var item indexInfo
		var keys string
		var unique, primary any
		var indexType any
		if err := rows.Scan(&item.Name, &keys, &unique, &primary, &indexType, &item.Filter); err != nil {
			return nil, err
		}
		item.Columns = parseIndexKeys(keys)
		item.IsUnique = truthy(unique)
		item.IsPrimary = truthy(primary)
		item.IndexType = stringPtr(indexTypeName(indexType))
		item.IncludedColumns = []string{}
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) listForeignKeys(schema, table string) ([]foreignKeyInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	table = strings.ToUpper(strings.TrimSpace(table))
	rows, err := s.queryRows(`
SELECT c.CONS_NAME, c.DEFINE, rt.TABLE_NAME
FROM SYS_CONSTRAINTS c
JOIN SYS_TABLES t ON t.DB_ID = c.DB_ID AND t.TABLE_ID = c.TABLE_ID
JOIN SYS_TABLES rt ON rt.DB_ID = c.DB_ID AND rt.TABLE_ID = c.REF_TABLE_ID
JOIN SYS_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)
  AND c.CONS_TYPE = 'F'
ORDER BY c.CONS_NAME`, []any{schema, table})
	if err != nil {
		if isXuguMetadataAccessError(err) {
			return []foreignKeyInfo{}, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)
	var result []foreignKeyInfo
	for rows.Next() {
		var name, define, refTable string
		if err := rows.Scan(&name, &define, &refTable); err != nil {
			return nil, err
		}
		local, ref := parseForeignKeyColumns(define)
		for i, column := range local {
			item := foreignKeyInfo{Name: name, Column: column, RefTable: refTable}
			if i < len(ref) {
				item.RefColumn = ref[i]
			}
			result = append(result, item)
		}
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) listTriggers(schema, table string) ([]triggerInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	table = strings.ToUpper(strings.TrimSpace(table))
	rows, err := s.queryRows(`
SELECT tr.TRIG_NAME, tr.TRIG_EVENT, tr.TRIG_TIME
FROM SYS_TRIGGERS tr
JOIN SYS_TABLES t ON t.DB_ID = tr.DB_ID AND t.TABLE_ID = tr.OBJ_ID
JOIN SYS_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)
ORDER BY tr.TRIG_NAME`, []any{schema, table})
	if err != nil {
		if isXuguMetadataAccessError(err) {
			return []triggerInfo{}, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)
	var result []triggerInfo
	for rows.Next() {
		var item triggerInfo
		var event, timing any
		if err := rows.Scan(&item.Name, &event, &timing); err != nil {
			return nil, err
		}
		item.Event = triggerEventName(event)
		item.Timing = triggerTimingName(timing)
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) getObjectSource(schema, name, objectType string) (map[string]any, error) {
	var err error
	schema, err = s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	sourceSQL, args, err := objectSourceQuery(schema, name, objectType)
	if err != nil {
		return nil, err
	}
	rows, err := s.queryRows(sourceSQL, args)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var builder strings.Builder
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return nil, err
		}
		builder.WriteString(line)
	}
	result := map[string]any{"name": name, "object_type": objectType, "schema": schema, "source": builder.String()}
	normalizedType := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(objectType), "_", " "))
	if normalizedType == "TYPE" || normalizedType == "TYPE BODY" {
		// Type source is exposed as catalog SPEC/BODY text, but cannot be safely edited as DDL.
		result["editable"] = false
	}
	return result, rows.Err()
}

func (s *server) getTableDDL(schema, table string) (string, error) {
	var err error
	schema, err = s.normalizeSchema(schema)
	if err != nil {
		return "", err
	}
	// DBMS_METADATA.GET_DDL can block indefinitely on XuguDB, even when the
	// table metadata itself is accessible. Reconstruct the DDL from the same
	// ALL_* catalog views used by the object browser instead.
	ddl, err := s.buildTableDDL(schema, table)
	if err != nil {
		return "", err
	}
	return s.appendTableIndexDDL(schema, table, ddl), nil
}

func (s *server) getExplainInfo(sqlText string) (string, error) {
	if strings.TrimSpace(sqlText) == "" {
		return "", errors.New("sql is required")
	}
	rows, err := s.queryRows("EXPLAIN "+trimStatementSQL(sqlText), nil)
	if err != nil {
		return "", err
	}
	defer s.closeRows(rows)
	columns, err := rows.Columns()
	if err != nil {
		return "", err
	}
	var builder strings.Builder
	for rows.Next() {
		values, err := scanRow(rows, len(columns))
		if err != nil {
			return "", err
		}
		builder.WriteString(joinValues(values, "\t"))
		builder.WriteByte('\n')
	}
	return strings.TrimSpace(builder.String()), rows.Err()
}

func (s *server) executeTransaction(params map[string]json.RawMessage) (queryResult, error) {
	var payload struct {
		Statements []string `json:"statements"`
		Schema     string   `json:"schema"`
	}
	if err := decodeParams(params, &payload); err != nil {
		return queryResult{}, err
	}
	db, err := s.requireDB()
	if err != nil {
		return queryResult{}, err
	}
	ctx, cancel := s.beginActiveOperation()
	defer s.endActiveOperation(cancel)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return queryResult{}, err
	}
	if strings.TrimSpace(payload.Schema) != "" {
		if _, err := tx.ExecContext(ctx, "SET SCHEMA "+quoteIdentifier(payload.Schema)); err != nil {
			tx.Rollback()
			return queryResult{}, err
		}
	}
	var affected int64
	start := time.Now()
	for _, statement := range payload.Statements {
		statement = trimStatementSQL(statement)
		if statement == "" {
			continue
		}
		result, err := tx.ExecContext(ctx, statement)
		if err != nil {
			tx.Rollback()
			return queryResult{}, err
		}
		count, _ := result.RowsAffected()
		affected += count
	}
	if err := tx.Commit(); err != nil {
		return queryResult{}, err
	}
	return queryResult{
		Columns:         []string{},
		ColumnTypes:     []string{},
		Rows:            [][]any{},
		AffectedRows:    affected,
		ExecutionTimeMS: time.Since(start).Milliseconds(),
	}, nil
}

func (s *server) executeQueryPage(opts queryOptions, pageSize int) (queryPageResult, error) {
	start := time.Now()
	if err := s.useDatabase(opts.Database); err != nil {
		return queryPageResult{}, err
	}
	if strings.TrimSpace(opts.Schema) != "" {
		if err := s.setSchema(opts.Schema); err != nil {
			return queryPageResult{}, err
		}
	}
	sqlText := trimStatementSQL(opts.SQL)
	if !isQuerySQL(sqlText) {
		result, err := s.executeQuery(opts)
		return queryPageResult{
			Columns:         result.Columns,
			ColumnTypes:     result.ColumnTypes,
			Rows:            result.Rows,
			AffectedRows:    result.AffectedRows,
			ExecutionTimeMS: result.ExecutionTimeMS,
			Truncated:       result.Truncated,
			SessionID:       nil,
			HasMore:         false,
		}, err
	}
	rows, err := s.queryRowsWithTimeout(sqlText, nil, opts.TimeoutSecs)
	if err != nil {
		return queryPageResult{}, err
	}
	columns, err := rows.Columns()
	if err != nil {
		s.closeRows(rows)
		return queryPageResult{}, err
	}
	columnTypes := columnTypeNames(rows)
	maxRows := opts.MaxRows
	if maxRows <= 0 {
		maxRows = defaultMaxRows
	}
	session := &querySession{rows: rows, columns: columns, columnTypes: columnTypes, remaining: maxRows}
	result, err := readQuerySessionPage(session, pageSize)
	result.ExecutionTimeMS = time.Since(start).Milliseconds()
	if err != nil {
		s.closeRows(rows)
		return queryPageResult{}, err
	}
	if result.HasMore {
		sessionID := s.storeQuerySession(session)
		result.SessionID = &sessionID
	} else {
		s.closeRows(rows)
	}
	return result, nil
}

func (s *server) fetchQueryPage(sessionID string, pageSize int) (queryPageResult, error) {
	session := s.sessions[sessionID]
	if session == nil {
		return queryPageResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}, SessionID: nil, HasMore: false}, nil
	}
	result, err := readQuerySessionPage(session, pageSize)
	if err != nil {
		s.closeQuerySession(sessionID)
		return queryPageResult{}, err
	}
	if result.HasMore {
		result.SessionID = &sessionID
	} else {
		s.closeQuerySession(sessionID)
	}
	return result, nil
}

func (s *server) storeQuerySession(session *querySession) string {
	s.nextSessionID++
	sessionID := fmt.Sprintf("xugu-%d", s.nextSessionID)
	s.sessions[sessionID] = session
	return sessionID
}

func (s *server) closeQuerySession(sessionID string) bool {
	session := s.sessions[sessionID]
	if session == nil {
		return false
	}
	s.closeRows(session.rows)
	delete(s.sessions, sessionID)
	return true
}

func (s *server) closeAllQuerySessions() {
	for sessionID := range s.sessions {
		s.closeQuerySession(sessionID)
	}
}

func readQuerySessionPage(session *querySession, pageSize int) (queryPageResult, error) {
	if pageSize <= 0 {
		pageSize = defaultMaxRows
	}
	result := queryPageResult{Columns: session.columns, ColumnTypes: session.columnTypes, Rows: [][]any{}, SessionID: nil, HasMore: false}
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
		return result, nil
	}
	return result, session.rows.Err()
}

func (s *server) executeQuery(opts queryOptions) (queryResult, error) {
	start := time.Now()
	if err := s.useDatabase(opts.Database); err != nil {
		return queryResult{}, err
	}
	if strings.TrimSpace(opts.Schema) != "" {
		if err := s.setSchema(opts.Schema); err != nil {
			return queryResult{}, err
		}
	}
	sqlText := trimStatementSQL(opts.SQL)
	maxRows := opts.MaxRows
	if maxRows <= 0 {
		maxRows = defaultMaxRows
	}
	if isQuerySQL(sqlText) {
		result, err := s.executeSelect(sqlText, maxRows, opts.TimeoutSecs)
		result.ExecutionTimeMS = time.Since(start).Milliseconds()
		return result, err
	}
	db, err := s.requireDB()
	if err != nil {
		return queryResult{}, err
	}
	ctx, cancel := s.beginActiveOperationWithTimeout(opts.TimeoutSecs)
	defer s.endActiveOperation(cancel)
	execResult, err := db.ExecContext(ctx, sqlText)
	if err != nil {
		return queryResult{}, err
	}
	affected, _ := execResult.RowsAffected()
	return queryResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}, AffectedRows: affected, ExecutionTimeMS: time.Since(start).Milliseconds()}, nil
}

func (s *server) executeSelect(sqlText string, maxRows int, timeoutSecs int) (queryResult, error) {
	rows, err := s.queryRowsWithTimeout(sqlText, nil, timeoutSecs)
	if err != nil {
		return queryResult{}, err
	}
	defer s.closeRows(rows)
	columns, err := rows.Columns()
	if err != nil {
		return queryResult{}, err
	}
	result := queryResult{Columns: columns, ColumnTypes: columnTypeNames(rows), Rows: [][]any{}}
	for rows.Next() {
		if len(result.Rows) >= maxRows {
			result.Truncated = true
			break
		}
		values, err := scanRow(rows, len(columns))
		if err != nil {
			return queryResult{}, err
		}
		result.Rows = append(result.Rows, values)
	}
	return result, rows.Err()
}

func scanRow(rows *sql.Rows, columnCount int) ([]any, error) {
	values := make([]any, columnCount)
	scanTargets := make([]any, columnCount)
	for i := range values {
		scanTargets[i] = &values[i]
	}
	if err := rows.Scan(scanTargets...); err != nil {
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
	result := make([]string, 0, len(types))
	for _, columnType := range types {
		result = append(result, columnType.DatabaseTypeName())
	}
	return result
}

func (s *server) setSchema(schema string) error {
	db, err := s.requireDB()
	if err != nil {
		return err
	}
	ctx, cancel := s.beginActiveOperation()
	defer s.endActiveOperation(cancel)
	_, err = db.ExecContext(ctx, "SET SCHEMA "+quoteIdentifier(schema))
	return err
}

func (s *server) queryRows(sqlText string, args []any) (*sql.Rows, error) {
	return s.queryRowsWithTimeout(sqlText, args, 0)
}

func (s *server) queryRowsWithTimeout(sqlText string, args []any, timeoutSecs int) (*sql.Rows, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginActiveOperationWithTimeout(timeoutSecs)
	rows, queryErr := db.QueryContext(ctx, sqlText, args...)
	s.activeCancelMu.Lock()
	s.activeCancel = nil
	if s.activeTimer != nil {
		s.activeTimer.Stop()
		s.activeTimer = nil
	}
	timedOut := s.activeTimedOut
	if queryErr != nil {
		cancel()
	} else if timedOut {
		cancel()
		if rows != nil {
			rows.Close()
		}
		queryErr = fmt.Errorf("query timed out after %ds", timeoutSecs)
	} else {
		s.activeRows[rows] = cancel
	}
	s.activeCancelMu.Unlock()
	return rows, queryErr
}

func (s *server) beginActiveOperation() (context.Context, context.CancelFunc) {
	return s.beginActiveOperationWithTimeout(0)
}

func (s *server) beginActiveOperationWithTimeout(timeoutSecs int) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	var timer *time.Timer
	if timeoutSecs > 0 {
		var t *time.Timer
		t = time.AfterFunc(time.Duration(timeoutSecs)*time.Second, func() {
			s.activeCancelMu.Lock()
			if s.activeTimer == t {
				s.activeTimedOut = true
				cancel()
				if s.killSession != nil {
					s.killSession()
				}
			}
			s.activeCancelMu.Unlock()
		})
		timer = t
	}
	s.activeCancelMu.Lock()
	s.activeCancel = cancel
	s.activeTimer = timer
	s.activeTimedOut = false
	s.activeCancelMu.Unlock()
	return ctx, cancel
}

func (s *server) endActiveOperation(cancel context.CancelFunc) {
	cancel()
	s.activeCancelMu.Lock()
	s.activeCancel = nil
	if s.activeTimer != nil {
		s.activeTimer.Stop()
		s.activeTimer = nil
	}
	s.activeCancelMu.Unlock()
}

func (s *server) cancelActiveQuery() {
	s.activeCancelMu.Lock()
	cancels := make([]context.CancelFunc, 0, len(s.activeRows)+1)
	if s.activeCancel != nil {
		cancels = append(cancels, s.activeCancel)
	}
	for _, cancel := range s.activeRows {
		cancels = append(cancels, cancel)
	}
	s.activeCancelMu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	if len(cancels) > 0 && s.killSession != nil {
		// go-xugu-driver does not implement QueryerContext/ExecerContext and
		// blocks in network reads, so context cancellation alone cannot interrupt
		// an in-flight statement. Xugu's control procedure stops the target
		// session's current transaction while preserving the connection. Runtime
		// sessions share one control connection per database endpoint.
		s.killSession()
	}
}

func (s *server) closeRows(rows *sql.Rows) error {
	if rows == nil {
		return nil
	}
	s.activeCancelMu.Lock()
	cancel := s.activeRows[rows]
	delete(s.activeRows, rows)
	s.activeCancelMu.Unlock()
	if cancel != nil {
		cancel()
	}
	return rows.Close()
}

func objectSourceQuery(schema, name, objectType string) (string, []any, error) {
	objectType = strings.ToUpper(strings.TrimSpace(objectType))
	name = strings.ToUpper(strings.TrimSpace(name))
	switch objectType {
	case "VIEW":
		return `
SELECT TO_CHAR(v.DEFINE)
FROM ALL_VIEWS v
JOIN ALL_SCHEMAS s ON s.DB_ID = v.DB_ID AND s.SCHEMA_ID = v.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(v.VIEW_NAME) = UPPER(?)`, []any{schema, name}, nil
	case "TRIGGER":
		return `
SELECT TO_CHAR(t.DEFINE)
FROM ALL_TRIGGERS t
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(t.TRIG_NAME) = UPPER(?)`, []any{schema, name}, nil
	case "PROCEDURE", "FUNCTION":
		return `
SELECT TO_CHAR(p.DEFINE)
FROM ALL_PROCEDURES p
JOIN ALL_SCHEMAS s ON s.DB_ID = p.DB_ID AND s.SCHEMA_ID = p.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(p.PROC_NAME) = UPPER(?)`, []any{schema, name}, nil
	case "PACKAGE":
		return `
SELECT COALESCE(TO_CHAR(k.SPEC), '')
FROM ALL_PACKAGES k
JOIN ALL_SCHEMAS s ON s.DB_ID = k.DB_ID AND s.SCHEMA_ID = k.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(k.PACK_NAME) = UPPER(?)`, []any{schema, name}, nil
	case "PACKAGE BODY", "PACKAGE_BODY":
		return `
SELECT COALESCE(TO_CHAR(k.BODY), '')
FROM ALL_PACKAGES k
JOIN ALL_SCHEMAS s ON s.DB_ID = k.DB_ID AND s.SCHEMA_ID = k.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(k.PACK_NAME) = UPPER(?)`, []any{schema, name}, nil
	case "TYPE":
		return `
SELECT COALESCE(TO_CHAR(u.SPEC), '')
FROM ALL_TYPES u
JOIN ALL_SCHEMAS s ON s.DB_ID = u.DB_ID AND s.SCHEMA_ID = u.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(u.TYPE_NAME) = UPPER(?)`, []any{schema, name}, nil
	case "TYPE BODY", "TYPE_BODY":
		return `
SELECT COALESCE(TO_CHAR(u.BODY), '')
FROM ALL_TYPES u
JOIN ALL_SCHEMAS s ON s.DB_ID = u.DB_ID AND s.SCHEMA_ID = u.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(u.TYPE_NAME) = UPPER(?)
  AND u.BODY IS NOT NULL`, []any{schema, name}, nil
	default:
		return "", nil, fmt.Errorf("object source is not supported for %s", objectType)
	}
}

func (s *server) buildTableDDL(schema, table string) (string, error) {
	columns, err := s.getColumns(schema, table)
	if err != nil {
		return "", err
	}
	if len(columns) == 0 {
		return "", fmt.Errorf("table not found: %s.%s", schema, table)
	}
	metadata, err := s.tableMetadata(schema, table)
	if err != nil {
		return "", err
	}
	identities, err := s.tableIdentities(schema, table)
	if err != nil {
		return "", err
	}
	constraints, err := s.tableConstraints(schema, table)
	if err != nil {
		return "", err
	}
	partitions, err := s.tablePartitions(schema, table, false)
	if err != nil {
		return "", err
	}
	subpartitions, err := s.tablePartitions(schema, table, true)
	if err != nil {
		return "", err
	}
	return renderXuguTableDDL(schema, table, columns, metadata, identities, constraints, partitions, subpartitions), nil
}

func (s *server) tableMetadata(schema, table string) (xuguTableMetadata, error) {
	rows, err := s.queryRows(xuguTableMetadataSQL, []any{schema, table})
	if err != nil {
		return xuguTableMetadata{}, err
	}
	defer s.closeRows(rows)
	var item xuguTableMetadata
	if !rows.Next() {
		return item, rows.Err()
	}
	var tempType, onCommitDelete, pctFree, copyNum, partitionType, partitionCount, partitionKey any
	var autoType, autoSpan, subpartitionType, subpartitionCount, subpartitionKey, comment any
	if err := rows.Scan(&tempType, &onCommitDelete, &pctFree, &copyNum, &partitionType, &partitionCount, &partitionKey,
		&autoType, &autoSpan, &subpartitionType, &subpartitionCount, &subpartitionKey, &comment); err != nil {
		return item, err
	}
	item.TempType = xuguInt(tempType)
	item.OnCommitDelete = truthy(onCommitDelete)
	item.PctFree = xuguInt(pctFree)
	item.CopyNum = xuguInt(copyNum)
	item.PartitionType = xuguInt(partitionType)
	item.PartitionCount = xuguInt(partitionCount)
	item.PartitionKey = xuguString(partitionKey)
	item.AutoPartitionType = xuguInt(autoType)
	item.AutoPartitionSpan = xuguInt(autoSpan)
	item.SubpartitionType = xuguInt(subpartitionType)
	item.SubpartitionCount = xuguInt(subpartitionCount)
	item.SubpartitionKey = xuguString(subpartitionKey)
	item.Comment = xuguString(comment)
	return item, rows.Err()
}

func (s *server) tableIdentities(schema, table string) (map[string]xuguIdentityInfo, error) {
	rows, err := s.queryRows(xuguTableIdentitySQL, []any{schema, table})
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	result := map[string]xuguIdentityInfo{}
	for rows.Next() {
		var column, start, step any
		if err := rows.Scan(&column, &start, &step); err != nil {
			return nil, err
		}
		item := xuguIdentityInfo{Column: xuguString(column), Start: int64(xuguInt(start)), Step: int64(xuguInt(step))}
		result[strings.ToUpper(item.Column)] = item
	}
	return result, rows.Err()
}

func (s *server) tableConstraints(schema, table string) ([]xuguConstraintInfo, error) {
	rows, err := s.queryRows(xuguTableConstraintsSQL, []any{schema, table})
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var result []xuguConstraintInfo
	for rows.Next() {
		var item xuguConstraintInfo
		var name, constraintType, definition, referenceSchema, referenceTable any
		var matchType, updateAction, deleteAction, deferrable, initiallyDeferred, enabled any
		if err := rows.Scan(&name, &constraintType, &definition, &referenceSchema, &referenceTable,
			&matchType, &updateAction, &deleteAction, &deferrable, &initiallyDeferred, &enabled); err != nil {
			return nil, err
		}
		item.Name = xuguString(name)
		item.Type = xuguString(constraintType)
		item.Definition = xuguString(definition)
		item.ReferenceSchema = xuguString(referenceSchema)
		item.ReferenceTable = xuguString(referenceTable)
		item.MatchType = xuguString(matchType)
		item.UpdateAction = xuguString(updateAction)
		item.DeleteAction = xuguString(deleteAction)
		item.Deferrable = truthy(deferrable)
		item.InitiallyDeferred = truthy(initiallyDeferred)
		item.Enabled = truthy(enabled)
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) tablePartitions(schema, table string, subpartition bool) ([]xuguPartitionInfo, error) {
	query := xuguTablePartitionsSQL
	if subpartition {
		query = xuguTableSubpartitionsSQL
	}
	rows, err := s.queryRows(query, []any{schema, table})
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var result []xuguPartitionInfo
	for rows.Next() {
		var name, value any
		if err := rows.Scan(&name, &value); err != nil {
			return nil, err
		}
		result = append(result, xuguPartitionInfo{Name: xuguString(name), Value: xuguString(value)})
	}
	return emptyIfNil(result), rows.Err()
}

// renderXuguTableDDL is deliberately independent from database access.  The
// exporter can consequently be regression-tested against the catalog data
// returned by Xugu without requiring a privileged DBMS_METADATA call.
func renderXuguTableDDL(schema, table string, columns []columnInfo, metadata xuguTableMetadata, identities map[string]xuguIdentityInfo, constraints []xuguConstraintInfo, partitions, subpartitions []xuguPartitionInfo) string {
	var builder strings.Builder
	switch metadata.TempType {
	case 2:
		builder.WriteString("CREATE GLOBAL TEMP TABLE ")
	case 1:
		builder.WriteString("CREATE TEMP TABLE ")
	default:
		builder.WriteString("CREATE TABLE ")
	}
	builder.WriteString(quoteIdentifier(schema))
	builder.WriteByte('.')
	builder.WriteString(quoteIdentifier(table))
	builder.WriteString(" (\n")
	items := make([]string, 0, len(columns)+len(constraints))
	for _, column := range columns {
		var item strings.Builder
		item.WriteString("  ")
		item.WriteString(quoteIdentifier(column.Name))
		item.WriteByte(' ')
		item.WriteString(columnTypeDDL(column))
		if identity, ok := identities[strings.ToUpper(column.Name)]; ok {
			item.WriteString(fmt.Sprintf(" IDENTITY(%d,%d)", identity.Start, identity.Step))
		}
		if column.ColumnDefault != nil && strings.TrimSpace(*column.ColumnDefault) != "" {
			item.WriteString(" DEFAULT ")
			switch column.DefaultOnNull {
			case 1:
				// ON_NULL=1 means that an explicit NULL is replaced during insert.
				// The explicit spelling also covers the legacy DEFAULT ON NULL form.
				item.WriteString("ON NULL FOR INSERT ONLY ")
			case 2:
				item.WriteString("ON NULL FOR INSERT AND UPDATE ")
			}
			item.WriteString(strings.TrimSpace(*column.ColumnDefault))
		}
		if !column.IsNullable {
			item.WriteString(" NOT NULL")
		}
		if column.Comment != nil && strings.TrimSpace(*column.Comment) != "" {
			item.WriteString(" COMMENT ")
			item.WriteString(quoteStringLiteral(strings.TrimSpace(*column.Comment)))
		}
		items = append(items, item.String())
	}
	for _, constraint := range constraints {
		if item := renderXuguConstraintDDL(constraint); item != "" {
			items = append(items, "  "+item)
		}
	}
	builder.WriteString(strings.Join(items, ",\n"))
	builder.WriteString("\n)")
	if metadata.TempType != 0 {
		if metadata.OnCommitDelete {
			builder.WriteString(" ON COMMIT DELETE ROWS")
		} else {
			builder.WriteString(" ON COMMIT PRESERVE ROWS")
		}
	}
	builder.WriteString(renderXuguPartitionDDL(metadata, partitions, subpartitions))
	// Xugu's CREATE TABLE grammar places storage attributes after the
	// partition/subpartition clause (not between the table body and PARTITION).
	if metadata.PctFree > 0 {
		builder.WriteString(fmt.Sprintf(" PCTFREE %d", metadata.PctFree))
	}
	if metadata.CopyNum > 0 {
		builder.WriteString(fmt.Sprintf(" COPY NUMBER %d", metadata.CopyNum))
	}
	if strings.TrimSpace(metadata.Comment) != "" {
		builder.WriteString("\nCOMMENT ")
		builder.WriteString(quoteStringLiteral(strings.TrimSpace(metadata.Comment)))
	}
	for _, constraint := range constraints {
		if !constraint.Enabled && strings.TrimSpace(constraint.Name) != "" {
			builder.WriteString(";\n\nALTER TABLE ")
			builder.WriteString(quoteIdentifier(schema))
			builder.WriteByte('.')
			builder.WriteString(quoteIdentifier(table))
			builder.WriteString(" DISABLE CONSTRAINT ")
			builder.WriteString(quoteIdentifier(constraint.Name))
		}
	}
	return builder.String()
}

func renderXuguConstraintDDL(constraint xuguConstraintInfo) string {
	name := strings.TrimSpace(constraint.Name)
	definition := strings.TrimSpace(constraint.Definition)
	if name == "" || definition == "" {
		return ""
	}
	prefix := "CONSTRAINT " + quoteIdentifier(name) + " "
	switch strings.ToUpper(strings.TrimSpace(constraint.Type)) {
	case "P":
		return prefix + "PRIMARY KEY (" + definition + ")"
	case "U":
		return prefix + "UNIQUE (" + definition + ")"
	case "C":
		return prefix + "CHECK (" + definition + ")"
	case "F":
		localColumns, referencedColumns := parseForeignKeyColumns(definition)
		if len(localColumns) == 0 || len(referencedColumns) == 0 || strings.TrimSpace(constraint.ReferenceTable) == "" {
			return ""
		}
		var builder strings.Builder
		builder.WriteString(prefix)
		builder.WriteString("FOREIGN KEY (")
		builder.WriteString(quotedIdentifiers(localColumns))
		builder.WriteString(") REFERENCES ")
		if strings.TrimSpace(constraint.ReferenceSchema) != "" {
			builder.WriteString(quoteIdentifier(constraint.ReferenceSchema))
			builder.WriteByte('.')
		}
		builder.WriteString(quoteIdentifier(constraint.ReferenceTable))
		builder.WriteString(" (")
		builder.WriteString(quotedIdentifiers(referencedColumns))
		builder.WriteByte(')')
		if match := xuguMatchClause(constraint.MatchType); match != "" {
			builder.WriteByte(' ')
			builder.WriteString(match)
		}
		if action := xuguReferentialAction(constraint.UpdateAction); action != "" {
			builder.WriteString(" ON UPDATE ")
			builder.WriteString(action)
		}
		if action := xuguReferentialAction(constraint.DeleteAction); action != "" {
			builder.WriteString(" ON DELETE ")
			builder.WriteString(action)
		}
		if constraint.Deferrable {
			builder.WriteString(" DEFERRABLE")
			if constraint.InitiallyDeferred {
				builder.WriteString(" INITIALLY DEFERRED")
			} else {
				builder.WriteString(" INITIALLY IMMEDIATE")
			}
		} else {
			builder.WriteString(" NOT DEFERRABLE")
		}
		return builder.String()
	default:
		return ""
	}
}

func renderXuguPartitionDDL(metadata xuguTableMetadata, partitions, subpartitions []xuguPartitionInfo) string {
	var builder strings.Builder
	if key := strings.TrimSpace(metadata.PartitionKey); key != "" && metadata.PartitionType != 0 {
		typeName := xuguPartitionType(metadata.PartitionType)
		if typeName != "" {
			builder.WriteString(" PARTITION BY ")
			builder.WriteString(typeName)
			builder.WriteString(" (")
			builder.WriteString(key)
			builder.WriteByte(')')
			if metadata.AutoPartitionType != 0 && metadata.AutoPartitionSpan > 0 {
				if interval := xuguAutoPartitionInterval(metadata.AutoPartitionType, metadata.AutoPartitionSpan); interval != "" {
					builder.WriteString(" INTERVAL ")
					builder.WriteString(interval)
				}
			}
			if metadata.PartitionType == 3 {
				// HASH partitions have no RANGE/LIST-style values. ALL_PARTIS can
				// contain physical hash-partition rows, but only their count belongs
				// in CREATE TABLE syntax.
				count := metadata.PartitionCount
				if count <= 0 {
					count = len(partitions)
				}
				if count > 0 {
					builder.WriteString(fmt.Sprintf(" PARTITIONS %d", count))
				}
			} else if len(partitions) > 0 {
				builder.WriteString(" PARTITIONS (\n")
				for i, partition := range partitions {
					if i > 0 {
						builder.WriteString(",\n")
					}
					builder.WriteString("  ")
					builder.WriteString(quoteIdentifier(partition.Name))
					builder.WriteByte(' ')
					if metadata.PartitionType == 1 {
						builder.WriteString("VALUES LESS THAN (")
					} else if metadata.PartitionType == 2 && strings.EqualFold(strings.TrimSpace(partition.Value), "OTHERVALUES") {
						builder.WriteString("VALUES (")
					} else {
						builder.WriteString("VALUES (")
					}
					builder.WriteString(strings.TrimSpace(partition.Value))
					builder.WriteByte(')')
				}
				builder.WriteString("\n)")
			}
		}
	}
	if key := strings.TrimSpace(metadata.SubpartitionKey); key != "" && metadata.SubpartitionType != 0 {
		typeName := xuguPartitionType(metadata.SubpartitionType)
		if typeName != "" {
			builder.WriteString(" SUBPARTITION BY ")
			builder.WriteString(typeName)
			builder.WriteString(" (")
			builder.WriteString(key)
			builder.WriteByte(')')
			if metadata.SubpartitionType == 3 {
				count := metadata.SubpartitionCount
				if count <= 0 {
					count = len(subpartitions)
				}
				if count > 0 {
					builder.WriteString(fmt.Sprintf(" SUBPARTITIONS %d", count))
				}
			} else if len(subpartitions) > 0 {
				builder.WriteString(" SUBPARTITIONS (\n")
				for i, partition := range subpartitions {
					if i > 0 {
						builder.WriteString(",\n")
					}
					builder.WriteString("  ")
					builder.WriteString(quoteIdentifier(partition.Name))
					builder.WriteByte(' ')
					if metadata.SubpartitionType == 1 {
						builder.WriteString("VALUES LESS THAN (")
					} else {
						builder.WriteString("VALUES (")
					}
					builder.WriteString(strings.TrimSpace(partition.Value))
					builder.WriteByte(')')
				}
				builder.WriteString("\n)")
			}
		}
	}
	return builder.String()
}

func quotedIdentifiers(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, quoteIdentifier(value))
	}
	return strings.Join(quoted, ", ")
}

func xuguReferentialAction(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "n":
		return "NO ACTION"
	case "r":
		return "RESTRICT"
	case "c":
		return "CASCADE"
	case "u":
		return "SET NULL"
	case "d":
		return "SET DEFAULT"
	default:
		return ""
	}
}

func xuguMatchClause(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "A":
		return "MATCH FULL"
	case "P":
		return "MATCH PARTIAL"
	case "U":
		// SIMPLE is Xugu's default and it is represented by omitting the
		// clause; unlike FULL/PARTIAL, `MATCH SIMPLE` is not valid Xugu SQL.
		return ""
	default:
		return ""
	}
}

func xuguPartitionType(value int) string {
	switch value {
	case 1:
		return "RANGE"
	case 2:
		return "LIST"
	case 3:
		return "HASH"
	default:
		return ""
	}
}

func xuguAutoPartitionInterval(kind, span int) string {
	unit := map[int]string{1: "YEAR", 2: "MONTH", 3: "DAY", 4: "HOUR"}[kind]
	if unit == "" || span <= 0 {
		return ""
	}
	return fmt.Sprintf("%d %s", span, unit)
}

func (s *server) appendTableIndexDDL(schema, table, ddl string) string {
	indexes, err := s.listIndexes(schema, table)
	if err != nil || len(indexes) == 0 {
		return ddl
	}
	var builder strings.Builder
	for _, index := range indexes {
		if index.IsPrimary || len(index.Columns) == 0 {
			continue
		}
		if builder.Len() > 0 {
			builder.WriteString("\n")
		}
		if index.IsUnique {
			builder.WriteString("CREATE UNIQUE INDEX ")
		} else {
			builder.WriteString("CREATE INDEX ")
		}
		builder.WriteString(quoteIdentifier(index.Name))
		builder.WriteString(" ON ")
		builder.WriteString(quoteIdentifier(schema))
		builder.WriteByte('.')
		builder.WriteString(quoteIdentifier(table))
		builder.WriteByte('(')
		for i, column := range index.Columns {
			if i > 0 {
				builder.WriteString(", ")
			}
			builder.WriteString(quoteIdentifier(column))
		}
		builder.WriteByte(')')
		if index.IndexType != nil && strings.TrimSpace(*index.IndexType) != "" {
			builder.WriteString(" INDEXTYPE IS ")
			builder.WriteString(strings.TrimSpace(*index.IndexType))
		}
		builder.WriteByte(';')
	}
	if builder.Len() == 0 {
		return ddl
	}
	return appendDDLStatement(ddl, builder.String())
}

func (s *server) tableComment(schema, table string) (string, error) {
	rows, err := s.queryRows(`
SELECT t.COMMENTS
FROM ALL_TABLES t
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)`, []any{schema, table})
	if err != nil {
		return "", err
	}
	defer s.closeRows(rows)
	var comment *string
	if rows.Next() {
		if err := rows.Scan(&comment); err != nil {
			return "", err
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if comment == nil {
		return "", nil
	}
	return *comment, nil
}

func appendDDLStatement(ddl, extra string) string {
	ddl = strings.TrimRight(ddl, "\r\n\t ")
	extra = strings.TrimSpace(extra)
	if extra == "" {
		return ddl
	}
	if !strings.HasSuffix(ddl, ";") {
		ddl += ";"
	}
	return ddl + "\n\n" + extra
}

func columnTypeDDL(column columnInfo) string {
	dataType := strings.ToUpper(strings.TrimSpace(column.DataType))
	if column.CharacterMaximumLength != nil {
		return fmt.Sprintf("%s(%d)", dataType, *column.CharacterMaximumLength)
	}
	if column.NumericPrecision != nil && column.NumericScale != nil {
		return fmt.Sprintf("%s(%d,%d)", dataType, *column.NumericPrecision, *column.NumericScale)
	}
	return dataType
}

func decodeXuguScale(dataType string, scale *int) (*int, *int, *int) {
	if scale == nil || *scale < 0 {
		return nil, nil, nil
	}
	upper := strings.ToUpper(dataType)
	if strings.Contains(upper, "CHAR") || strings.Contains(upper, "BINARY") {
		length := *scale
		return nil, nil, &length
	}
	if strings.Contains(upper, "NUM") || strings.Contains(upper, "DECIMAL") {
		precision := *scale / 65536
		numericScale := *scale % 65536
		return &precision, &numericScale, nil
	}
	return nil, nil, nil
}

func normalizeXuguColumnType(dataType string, varying any) string {
	upper := strings.ToUpper(strings.TrimSpace(dataType))
	if !truthy(varying) {
		return dataType
	}
	switch upper {
	case "CHAR":
		return "VARCHAR"
	case "BINARY":
		return "VARBINARY"
	default:
		return dataType
	}
}

var quotedIdentifierRegexp = regexp.MustCompile(`"([^"]+)"`)

func parseQuotedIdentifiers(value string) []string {
	matches := quotedIdentifierRegexp.FindAllStringSubmatch(value, -1)
	result := make([]string, 0, len(matches))
	for _, match := range matches {
		if len(match) == 2 {
			result = append(result, match[1])
		}
	}
	return result
}

func parseIndexKeys(value string) []string {
	quoted := parseQuotedIdentifiers(value)
	if len(quoted) > 0 {
		return quoted
	}
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.Trim(strings.TrimSpace(part), `"`)
		if part != "" {
			result = append(result, part)
		}
	}
	return result
}

func parseForeignKeyColumns(define string) ([]string, []string) {
	groups := regexp.MustCompile(`\(([^()]*)\)`).FindAllStringSubmatch(define, -1)
	if len(groups) < 2 {
		columns := parseQuotedIdentifiers(define)
		if len(columns)%2 == 0 {
			mid := len(columns) / 2
			return columns[:mid], columns[mid:]
		}
		return columns, nil
	}
	return parseQuotedIdentifiers(groups[0][1]), parseQuotedIdentifiers(groups[1][1])
}

func truthy(value any) bool {
	switch v := normalizeValue(value).(type) {
	case bool:
		return v
	case int64:
		return v != 0
	case float64:
		return v != 0
	case string:
		upper := strings.ToUpper(strings.TrimSpace(v))
		return upper == "T" || upper == "TRUE" || upper == "1" || upper == "Y" || upper == "YES"
	default:
		return false
	}
}

func xuguString(value any) string {
	value = normalizeValue(value)
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func xuguInt(value any) int {
	value = normalizeValue(value)
	switch v := value.(type) {
	case int64:
		return int(v)
	case int:
		return v
	case float64:
		return int(v)
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(v))
		return parsed
	default:
		parsed, _ := strconv.Atoi(strings.TrimSpace(fmt.Sprint(v)))
		return parsed
	}
}

func stringPtr(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func quoteStringLiteral(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func indexTypeName(value any) string {
	switch fmt.Sprint(normalizeValue(value)) {
	case "0":
		return "BTREE"
	case "1":
		return "RTREE"
	case "2":
		return "FULLTEXT"
	case "3":
		return "BITMAP"
	default:
		return fmt.Sprint(normalizeValue(value))
	}
}

func triggerEventName(value any) string {
	switch fmt.Sprint(normalizeValue(value)) {
	case "1":
		return "INSERT"
	case "2":
		return "UPDATE"
	case "3":
		return "INSERT OR UPDATE"
	case "4":
		return "DELETE"
	case "5":
		return "INSERT OR DELETE"
	case "6":
		return "UPDATE OR DELETE"
	case "7":
		return "INSERT OR UPDATE OR DELETE"
	case "8":
		return "LOGON"
	default:
		return fmt.Sprint(normalizeValue(value))
	}
}

func triggerTimingName(value any) string {
	switch fmt.Sprint(normalizeValue(value)) {
	case "1":
		return "BEFORE"
	case "2":
		return "INSTEAD"
	case "4":
		return "AFTER"
	default:
		return fmt.Sprint(normalizeValue(value))
	}
}

func joinValues(values []any, sep string) string {
	parts := make([]string, len(values))
	for i, value := range values {
		if value == nil {
			parts[i] = ""
		} else {
			parts[i] = fmt.Sprint(value)
		}
	}
	return strings.Join(parts, sep)
}

func decodeParams(params map[string]json.RawMessage, target any) error {
	if params == nil {
		params = map[string]json.RawMessage{}
	}
	data, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func stringParam(params map[string]json.RawMessage, key string) string {
	if params == nil || len(params[key]) == 0 {
		return ""
	}
	var value string
	_ = json.Unmarshal(params[key], &value)
	return value
}

func intParam(params map[string]json.RawMessage, key string) int {
	if params == nil || len(params[key]) == 0 {
		return 0
	}
	var value int
	_ = json.Unmarshal(params[key], &value)
	return value
}

func stringSliceParam(params map[string]json.RawMessage, key string) []string {
	if params == nil || len(params[key]) == 0 {
		return nil
	}
	var values []string
	if err := json.Unmarshal(params[key], &values); err == nil {
		return values
	}
	var single string
	if err := json.Unmarshal(params[key], &single); err == nil && strings.TrimSpace(single) != "" {
		return []string{single}
	}
	return nil
}

func errorResponse(id json.RawMessage, err error) response {
	return response{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -1, Message: err.Error()}}
}

func trimStatementSQL(sqlText string) string {
	return strings.TrimRight(strings.TrimSpace(sqlText), "; \t\r\n")
}

func isQuerySQL(sqlText string) bool {
	lower := strings.ToLower(strings.TrimSpace(sqlText))
	return strings.HasPrefix(lower, "select") || strings.HasPrefix(lower, "with")
}

func quoteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func normalizeValue(value any) any {
	switch v := value.(type) {
	case nil:
		return nil
	case []byte:
		return string(v)
	case time.Time:
		return v.Format(time.RFC3339Nano)
	case int:
		return int64(v)
	case int8:
		return int64(v)
	case int16:
		return int64(v)
	case int32:
		return int64(v)
	case int64:
		return v
	case uint:
		return uint64(v)
	case uint8:
		return uint64(v)
	case uint16:
		return uint64(v)
	case uint32:
		return uint64(v)
	case uint64:
		return v
	case float32:
		return float64(v)
	case float64, bool, string:
		return v
	case fmt.Stringer:
		return v.String()
	default:
		return fmt.Sprint(v)
	}
}

func emptyIfNil[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}
