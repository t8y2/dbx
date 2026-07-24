package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/sijms/go-ora/v2"
	go_ora "github.com/sijms/go-ora/v2"
	"github.com/sijms/go-ora/v2/converters"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

const protocolVersion = 1
const multiSessionProtocolVersion = 2
const defaultMaxRows = 1000
const oracleCharsetZHS32GB18030 = 854
const legacyAgentSessionID = "__legacy__"
const maxAgentSessions = 256

var (
	oraclePlSQLBlockStartRegexp          = regexp.MustCompile(`(?is)^\s*(?:DECLARE|BEGIN|CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:EDITIONABLE|NONEDITIONABLE)\s+)?(?:FUNCTION|PROCEDURE|TRIGGER|PACKAGE(?:\s+BODY)?|TYPE(?:\s+BODY)?))\b`)
	oraclePlSQLBlockEndRegexp            = regexp.MustCompile(`(?is)\bEND\s*;\s*$`)
	oracleNamedPlSQLBlockEndRegexp       = regexp.MustCompile(`(?is)\bEND\s+([A-Z0-9_$#]+)\s*;\s*$`)
	oracleUnsupportedServerCharsetRegexp = regexp.MustCompile(`server use charset with id: ([0-9]+).*not supported by the driver`)
	oracleStringConverters               = map[int]converters.IStringConverter{
		oracleCharsetZHS32GB18030: oracleGB18030Converter{},
	}
)

const oracleListDatabasesSQL = `
SELECT username AS owner
FROM all_users
WHERE username IS NOT NULL
  AND username NOT IN (
    'SYS','SYSTEM','SYSMAN','DBSNMP','SYSBACKUP','SYSDG','SYSKM','SYSRAC','OUTLN',
    'AUDSYS','LBACSYS','DVF','DVSYS','APPQOSSYS','CTXSYS','MDSYS','MDDATA',
    'ORDSYS','ORDDATA','ORDPLUGINS','XDB','ANONYMOUS','EXFSYS',
    'GSMADMIN_INTERNAL','GSMCATUSER','GSMROOTUSER','GSMUSER','OJVMSYS','OLAPSYS',
    'ORACLE_OCM','SI_INFORMTN_SCHEMA','WMSYS','XS$NULL','DBSFWUSER',
    'REMOTE_SCHEDULER_AGENT','PDBADMIN','DGPDB_INT','OPS$ORACLE',
    'GGSYS','FLOWS_FILES','APEX_PUBLIC_USER'
  )
  AND username NOT LIKE 'APEX_%'
  AND username NOT LIKE 'FLOWS_%'
  AND username NOT LIKE '%$%'
ORDER BY CASE
  WHEN username = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') THEN 0
  WHEN username = SYS_CONTEXT('USERENV', 'SESSION_USER') THEN 1
  ELSE 2
END, username`

// Oracle schemas are users, so expose every user visible through ALL_USERS; system filtering remains database-picker behavior.
const oracleListSchemasSQL = `
SELECT username AS owner
FROM all_users
WHERE username IS NOT NULL
ORDER BY CASE
  WHEN username = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') THEN 0
  WHEN username = SYS_CONTEXT('USERENV', 'SESSION_USER') THEN 1
  ELSE 2
END, username`
const oracleListTablesBaseSQL = `
SELECT OBJECT_NAME, TABLE_TYPE, COMMENTS
FROM (
SELECT t.TABLE_NAME AS OBJECT_NAME,
       'TABLE' AS TABLE_TYPE,
       CAST(NULL AS VARCHAR2(4000)) AS COMMENTS
FROM ALL_TABLES t
WHERE t.OWNER = :1
  AND t.NESTED = 'NO'
UNION ALL
SELECT o.OBJECT_NAME,
       'VIEW' AS TABLE_TYPE,
       CAST(NULL AS VARCHAR2(4000)) AS COMMENTS
FROM ALL_OBJECTS o
WHERE o.OWNER = :2
  AND o.OBJECT_TYPE = 'VIEW'
)`
const oracleListTablesSessionUserBaseSQL = `
SELECT OBJECT_NAME, TABLE_TYPE, COMMENTS
FROM (
SELECT t.TABLE_NAME AS OBJECT_NAME,
       'TABLE' AS TABLE_TYPE,
       CAST(NULL AS VARCHAR2(4000)) AS COMMENTS
FROM USER_TABLES t
WHERE t.NESTED = 'NO'
UNION ALL
SELECT o.OBJECT_NAME,
       'VIEW' AS TABLE_TYPE,
       CAST(NULL AS VARCHAR2(4000)) AS COMMENTS
FROM USER_OBJECTS o
WHERE o.OBJECT_TYPE = 'VIEW'
)`
const oracleListTablesOrderSQL = `ORDER BY OBJECT_NAME`
const oracleListTablesSQL = oracleListTablesBaseSQL + "\n" + oracleListTablesOrderSQL
const oracleListObjectsBaseSQL = `
SELECT OBJECT_NAME, OBJECT_TYPE, COMMENTS
FROM (
SELECT t.TABLE_NAME AS OBJECT_NAME,
       'TABLE' AS OBJECT_TYPE,
       CAST(NULL AS VARCHAR2(4000)) AS COMMENTS
FROM ALL_TABLES t
WHERE t.OWNER = :1
  AND t.NESTED = 'NO'
UNION ALL
SELECT o.OBJECT_NAME,
       CASE o.OBJECT_TYPE WHEN 'PACKAGE BODY' THEN 'PACKAGE_BODY' ELSE o.OBJECT_TYPE END AS OBJECT_TYPE,
       CAST(NULL AS VARCHAR2(4000)) AS COMMENTS
FROM ALL_OBJECTS o
WHERE o.OWNER = :2
  AND o.OBJECT_TYPE IN ('VIEW', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY')
)`
const oracleListObjectsSessionUserBaseSQL = `
SELECT OBJECT_NAME, OBJECT_TYPE, COMMENTS
FROM (
SELECT t.TABLE_NAME AS OBJECT_NAME,
       'TABLE' AS OBJECT_TYPE,
       CAST(NULL AS VARCHAR2(4000)) AS COMMENTS
FROM USER_TABLES t
WHERE t.NESTED = 'NO'
UNION ALL
SELECT o.OBJECT_NAME,
       CASE o.OBJECT_TYPE WHEN 'PACKAGE BODY' THEN 'PACKAGE_BODY' ELSE o.OBJECT_TYPE END AS OBJECT_TYPE,
       CAST(NULL AS VARCHAR2(4000)) AS COMMENTS
FROM USER_OBJECTS o
WHERE o.OBJECT_TYPE IN ('VIEW', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY')
)`
const oracleListObjectsOrderSQL = `ORDER BY CASE OBJECT_TYPE
  WHEN 'TABLE' THEN 0
  WHEN 'VIEW' THEN 1
  WHEN 'PROCEDURE' THEN 2
  WHEN 'FUNCTION' THEN 3
  WHEN 'PACKAGE' THEN 4
  ELSE 5
END, OBJECT_NAME`
const oracleListObjectsSQL = oracleListObjectsBaseSQL + "\n" + oracleListObjectsOrderSQL
const oracleListTriggersSQL = `
SELECT t.TRIGGER_NAME,
       t.TRIGGERING_EVENT,
       t.TRIGGER_TYPE,
       t.DESCRIPTION,
       s.LINE,
       s.TEXT
FROM ALL_TRIGGERS t
LEFT JOIN ALL_SOURCE s
  ON s.OWNER = t.OWNER
 AND s.NAME = t.TRIGGER_NAME
 AND s.TYPE = 'TRIGGER'
WHERE t.OWNER = :1
  AND t.TABLE_NAME = :2
  AND t.BASE_OBJECT_TYPE IN ('TABLE', 'VIEW')
ORDER BY t.TRIGGER_NAME, s.LINE`

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

type oracleColumnMeta struct {
	Name     string
	DataType string
}

type oracleColumnMetaLoader func(schema, table string) ([]oracleColumnMeta, error)

type databaseInfo struct {
	Name string `json:"name"`
}

type tableInfo struct {
	Name      string  `json:"name"`
	TableType string  `json:"table_type"`
	Comment   *string `json:"comment"`
}

type metadataListConstraints struct {
	Filter      string
	Limit       int
	Offset      int
	ObjectTypes []string
}

type objectInfo struct {
	Name       string  `json:"name"`
	ObjectType string  `json:"object_type"`
	Schema     string  `json:"schema"`
	Comment    *string `json:"comment"`
}

type columnInfo struct {
	Name                   string  `json:"name"`
	DataType               string  `json:"data_type"`
	IsNullable             bool    `json:"is_nullable"`
	ColumnDefault          *string `json:"column_default"`
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

type triggerInfo struct {
	Name      string  `json:"name"`
	Event     string  `json:"event"`
	Timing    string  `json:"timing"`
	Statement *string `json:"statement,omitempty"`
}

type server struct {
	db                     *sql.DB
	params                 connectParams
	sessions               map[string]*querySession
	tableReadSessions      map[string]*querySession
	nextSessionID          int64
	nextTableReadSessionID int64
	activeCancelMu         sync.Mutex
	activeCancel           context.CancelFunc
	activeRows             map[*sql.Rows]context.CancelFunc
	activeTimer            *time.Timer
	activeTimedOut         bool
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
	runtime := newRuntimeServer()
	encoder := json.NewEncoder(os.Stdout)
	var encoderMu sync.Mutex
	var requests sync.WaitGroup
	shutdown := make(chan struct{})
	var shutdownOnce sync.Once
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
		go func() {
			defer requests.Done()
			resp, shouldShutdown := runtime.handleLine(line)
			encoderMu.Lock()
			err := encoder.Encode(resp)
			encoderMu.Unlock()
			if err != nil {
				fmt.Fprintf(os.Stderr, "failed to write response: %v\n", err)
				shutdownOnce.Do(func() { close(shutdown) })
				return
			}
			if shouldShutdown {
				shutdownOnce.Do(func() { close(shutdown) })
			}
		}()
		select {
		case <-shutdown:
			requests.Wait()
			return
		default:
		}
	}
	requests.Wait()
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintf(os.Stderr, "failed to read stdin: %v\n", err)
	}
}

func newRuntimeServer() *runtimeServer {
	return &runtimeServer{sessions: map[string]*agentSession{}}
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
		var connectParams connectParams
		if err := decodeParams(params, &connectParams); err != nil {
			return nil, false, err
		}
		return map[string]bool{"ok": true}, false, r.openSession(agentSessionID, connectParams)
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
		if _, _, err := session.server.dispatch("validate_connection", params); err == nil {
			return map[string]bool{"ok": true}, false, nil
		}
		// Reconnect only this logical session. Other sessions in the runtime keep
		// their connections, transactions, cursors, and in-flight requests.
		if err := session.server.connect(session.server.params); err != nil {
			return nil, false, err
		}
		return map[string]bool{"ok": true}, false, nil
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
		var connectParams connectParams
		if err := decodeParams(params, &connectParams); err != nil {
			return nil, false, err
		}
		return map[string]bool{"ok": true}, false, r.replaceSession(legacyAgentSessionID, connectParams)
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
	// Oracle connection state, transactions, and cursors are session-scoped;
	// serialize one session while allowing separate sessions to run in parallel.
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
	session := &agentSession{server: newServer()}
	r.sessions[agentSessionID] = session
	r.mu.Unlock()

	// Reserve the id under the registry lock, then connect outside it so unrelated
	// sessions can establish database connections concurrently.
	session.mu.Lock()
	err := session.server.connect(params)
	session.mu.Unlock()
	if err != nil {
		r.mu.Lock()
		if r.sessions[agentSessionID] == session {
			delete(r.sessions, agentSessionID)
		}
		r.mu.Unlock()
		return err
	}
	return nil
}

func (r *runtimeServer) replaceSession(agentSessionID string, params connectParams) error {
	_ = r.closeSession(agentSessionID)
	return r.openSession(agentSessionID, params)
}

func (r *runtimeServer) session(agentSessionID string) (*agentSession, error) {
	if agentSessionID == "" {
		return nil, errors.New("agentSessionId is required")
	}
	r.mu.RLock()
	session := r.sessions[agentSessionID]
	r.mu.RUnlock()
	if session == nil {
		return nil, fmt.Errorf("agent session not found: %s", agentSessionID)
	}
	return session, nil
}

func (r *runtimeServer) closeSession(agentSessionID string) error {
	if agentSessionID == "" {
		return errors.New("agentSessionId is required")
	}
	r.mu.Lock()
	session := r.sessions[agentSessionID]
	delete(r.sessions, agentSessionID)
	r.mu.Unlock()
	if session == nil {
		return nil
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.server.disconnect()
}

func (r *runtimeServer) closeAllSessions() error {
	r.mu.Lock()
	sessions := r.sessions
	r.sessions = map[string]*agentSession{}
	r.mu.Unlock()
	var firstErr error
	for _, session := range sessions {
		session.mu.Lock()
		err := session.server.disconnect()
		session.mu.Unlock()
		if firstErr == nil && err != nil {
			firstErr = err
		}
	}
	return firstErr
}

func newServer() *server {
	return &server{
		sessions:          map[string]*querySession{},
		tableReadSessions: map[string]*querySession{},
		activeRows:        map[*sql.Rows]context.CancelFunc{},
	}
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
		db, err := openAndPingDB(cp, 5*time.Second)
		if err != nil {
			return nil, false, err
		}
		defer db.Close()
		return map[string]bool{"ok": true}, false, nil
	case "validate_connection":
		if s.db == nil {
			return nil, false, errors.New("not connected")
		}
		return map[string]bool{"ok": true}, false, pingDB(s.db, 5*time.Second)
	case "list_databases":
		result, err := s.listDatabases()
		return result, false, err
	case "list_schemas":
		result, err := s.listSchemas(stringSliceParam(params, "visible_schemas"))
		return result, false, err
	case "list_tables":
		schema := stringParam(params, "schema")
		result, err := s.listTables(schema, metadataListConstraintsFromParams(params))
		return result, false, err
	case "list_objects":
		schema := stringParam(params, "schema")
		result, err := s.listObjects(schema, metadataListConstraintsFromParams(params))
		return result, false, err
	case "completion_assistant_search_v1":
		var request completionAssistantRequest
		if err := decodeParams(params, &request); err != nil {
			return nil, false, err
		}
		result, err := s.completionAssistantSearch(request)
		return result, false, err
	case "get_columns":
		schema := stringParam(params, "schema")
		table := stringParam(params, "table")
		result, err := s.getColumns(schema, table)
		return result, false, err
	case "get_object_source":
		schema := stringParam(params, "schema")
		name := stringParam(params, "name")
		objectType := stringParam(params, "object_type")
		source, err := s.getObjectSource(schema, name, objectType)
		return source, false, err
	case "get_table_ddl":
		schema := stringParam(params, "schema")
		table := stringParam(params, "table")
		objectType := stringParam(params, "object_type")
		ddl, err := s.getTableDDL(schema, table, objectType)
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
		result, err := s.startTableRead(opts, intParam(params, "pageSize"))
		return result, false, err
	case "fetch_table_read_page":
		result, err := s.fetchTableReadPage(stringParam(params, "sessionId"), intParam(params, "pageSize"))
		return result, false, err
	case "close_table_read_session":
		return s.closeTableReadSession(stringParam(params, "sessionId")), false, nil
	case "list_indexes":
		schema := stringParam(params, "schema")
		table := stringParam(params, "table")
		result, err := s.listIndexes(schema, table)
		return result, false, err
	case "list_foreign_keys":
		schema := stringParam(params, "schema")
		table := stringParam(params, "table")
		result, err := s.listForeignKeys(schema, table)
		return result, false, err
	case "list_triggers":
		schema := stringParam(params, "schema")
		table := stringParam(params, "table")
		result, err := s.listTriggers(schema, table)
		return result, false, err
	case "get_explain_info":
		sqlText := stringParam(params, "sql")
		plan, err := s.getExplainInfo(
			sqlText,
			stringParam(params, "database"),
			stringParam(params, "schema"),
			intParam(params, "timeoutSecs"),
		)
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
	_ = s.disconnect()
	db, err := openAndPingDB(params, 15*time.Second)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, "ALTER SESSION SET NLS_LANGUAGE='AMERICAN'"); err != nil {
		db.Close()
		return err
	}
	s.db = db
	s.params = params
	return nil
}

func (s *server) disconnect() error {
	s.closeAllQuerySessions()
	if s.db == nil {
		return nil
	}
	err := s.db.Close()
	s.db = nil
	return err
}

func openDB(params connectParams) (*sql.DB, error) {
	return openDBWithStringConverter(params, nil)
}

func openDBWithStringConverter(params connectParams, stringConverter converters.IStringConverter) (*sql.DB, error) {
	dsn, err := buildDSNForConnect(params)
	if err != nil {
		return nil, err
	}
	var db *sql.DB
	if stringConverter == nil {
		db, err = sql.Open("oracle", dsn)
		if err != nil {
			return nil, err
		}
	} else {
		connector := go_ora.NewConnector(dsn)
		go_ora.SetStringConverter(connector, stringConverter, nil)
		db = sql.OpenDB(connector)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(30 * time.Minute)
	return db, nil
}

func openAndPingDB(params connectParams, timeout time.Duration) (*sql.DB, error) {
	db, err := openDB(params)
	if err != nil {
		return nil, err
	}
	if err := pingDB(db, timeout); err != nil {
		db.Close()
		stringConverter, ok := oracleStringConverterForUnsupportedCharsetError(err)
		if !ok {
			return nil, err
		}
		// Retry only charsets with explicit converters. Guessing a converter
		// can make the connection succeed while silently corrupting text.
		db, err = openDBWithStringConverter(params, stringConverter)
		if err != nil {
			return nil, err
		}
		if retryErr := pingDB(db, timeout); retryErr != nil {
			db.Close()
			return nil, retryErr
		}
	}
	return db, nil
}

func pingDB(db *sql.DB, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return db.PingContext(ctx)
}

func oracleStringConverterForUnsupportedCharsetError(err error) (converters.IStringConverter, bool) {
	charsetID, ok := unsupportedOracleServerCharsetID(err)
	if !ok {
		return nil, false
	}
	stringConverter, ok := oracleStringConverters[charsetID]
	return stringConverter, ok
}

func unsupportedOracleServerCharsetID(err error) (int, bool) {
	if err == nil {
		return 0, false
	}
	match := oracleUnsupportedServerCharsetRegexp.FindStringSubmatch(err.Error())
	if len(match) != 2 {
		return 0, false
	}
	charsetID, parseErr := strconv.Atoi(match[1])
	if parseErr != nil {
		return 0, false
	}
	return charsetID, true
}

type oracleGB18030Converter struct{}

func (oracleGB18030Converter) Encode(input string) []byte {
	output, _, err := transform.String(simplifiedchinese.GB18030.NewEncoder(), input)
	if err != nil {
		return []byte(input)
	}
	return []byte(output)
}

func (oracleGB18030Converter) Decode(input []byte) string {
	output, _, err := transform.Bytes(simplifiedchinese.GB18030.NewDecoder(), input)
	if err != nil {
		return string(input)
	}
	return string(output)
}

func (oracleGB18030Converter) GetLangID() int {
	return oracleCharsetZHS32GB18030
}

func (oracleGB18030Converter) Clone() converters.IStringConverter {
	return oracleGB18030Converter{}
}

func buildDSN(params connectParams) string {
	connectionString := strings.TrimSpace(params.ConnectionString)
	if strings.HasPrefix(strings.ToLower(connectionString), "oracle://") {
		return connectionString
	}
	username := params.Username
	options := parseURLParams(params.URLParams)
	if params.SysDBA {
		options["AUTH TYPE"] = "SYSDBA"
	}

	if jdbc := parseOracleJDBCURL(connectionString); jdbc.Kind != "" {
		if jdbc.Descriptor != "" {
			return buildGoOraJDBC(username, params.Password, jdbc.Descriptor, options)
		}
		host := jdbc.Host
		port := jdbc.Port
		if port == 0 {
			port = 1521
		}
		if jdbc.Kind == "sid" {
			options["SID"] = jdbc.Database
			return buildGoOraURL(host, port, "", username, params.Password, options)
		}
		return buildGoOraURL(host, port, jdbc.Database, username, params.Password, options)
	}

	service := strings.TrimSpace(params.Database)
	if strings.HasPrefix(strings.ToUpper(service), "SYSDBA:") {
		service = strings.TrimSpace(service[len("SYSDBA:"):])
	}
	port := params.Port
	if port == 0 {
		port = 1521
	}
	return buildGoOraURL(params.Host, port, service, username, params.Password, options)
}

func buildGoOraJDBC(user, password, connStr string, options map[string]string) string {
	if options == nil {
		options = make(map[string]string)
	}
	options["connStr"] = connStr
	return buildGoOraURL("", 0, "", user, password, options)
}

func buildGoOraURL(server string, port int, service, user, password string, options map[string]string) string {
	// go-ora v2.9.0 uses path escaping for user/password, leaving ':' unescaped.
	// Userinfo escaping keeps bastion usernames such as 9008888:reader intact
	// without changing their authentication semantics.
	ret := fmt.Sprintf(
		"oracle://%s@%s/%s",
		url.UserPassword(user, password).String(),
		net.JoinHostPort(server, strconv.Itoa(port)),
		url.PathEscape(service),
	)
	if options != nil {
		ret += "?"
		for key, val := range options {
			val = strings.TrimSpace(val)
			for _, temp := range strings.Split(val, ",") {
				temp = strings.TrimSpace(temp)
				if strings.ToUpper(key) == "SERVER" {
					ret += fmt.Sprintf("%s=%s&", key, temp)
				} else {
					ret += fmt.Sprintf("%s=%s&", key, url.QueryEscape(temp))
				}
			}
		}
		ret = strings.TrimRight(ret, "&")
	}
	return ret
}

type jdbcURLInfo struct {
	Kind       string
	Host       string
	Port       int
	Database   string
	Descriptor string
}

var (
	oracleJDBCServiceRegexp = regexp.MustCompile(`(?i)^jdbc:oracle:thin:@//([^/:]+):([0-9]+)/([^?]+)`)
	oracleJDBCSIDRegexp     = regexp.MustCompile(`(?i)^jdbc:oracle:thin:@([^/:]+):([0-9]+):([^?]+)`)
	oracleJDBCLegacyRegexp  = regexp.MustCompile(`(?i)^jdbc:oracle:thin:@([^/:]+):([0-9]+)/([^?]+)`)
)

func parseOracleJDBCURL(value string) jdbcURLInfo {
	value = strings.TrimSpace(value)
	lower := strings.ToLower(value)
	if !strings.HasPrefix(lower, "jdbc:oracle:thin:@") {
		return jdbcURLInfo{}
	}
	descriptor := strings.TrimSpace(value[len("jdbc:oracle:thin:@"):])
	if strings.HasPrefix(descriptor, "(") {
		return jdbcURLInfo{Kind: "descriptor", Descriptor: descriptor}
	}
	if match := oracleJDBCServiceRegexp.FindStringSubmatch(value); len(match) == 4 {
		return jdbcURLInfo{Kind: "service", Host: match[1], Port: parsePort(match[2]), Database: match[3]}
	}
	if match := oracleJDBCSIDRegexp.FindStringSubmatch(value); len(match) == 4 {
		return jdbcURLInfo{Kind: "sid", Host: match[1], Port: parsePort(match[2]), Database: match[3]}
	}
	if match := oracleJDBCLegacyRegexp.FindStringSubmatch(value); len(match) == 4 {
		return jdbcURLInfo{Kind: "service", Host: match[1], Port: parsePort(match[2]), Database: match[3]}
	}
	return jdbcURLInfo{}
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

func (s *server) listDatabases() ([]databaseInfo, error) {
	rows, err := s.queryRows(oracleListDatabasesSQL, nil)
	if err != nil {
		if isOraclePGALimitError(err) {
			return s.currentSchemaDatabase()
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
	if err := rows.Err(); err != nil {
		if isOraclePGALimitError(err) {
			return s.currentSchemaDatabase()
		}
		return nil, err
	}
	return emptyIfNil(result), nil
}

func isOraclePGALimitError(err error) bool {
	return err != nil && strings.Contains(strings.ToUpper(err.Error()), "ORA-04036")
}

func (s *server) currentSchemaDatabase() ([]databaseInfo, error) {
	schema, err := s.currentSchema()
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(schema) == "" {
		return []databaseInfo{}, nil
	}
	return []databaseInfo{{Name: schema}}, nil
}

func (s *server) listSchemas(visibleSchemas []string) ([]string, error) {
	if visibleSchemas != nil && len(visibleSchemas) == 0 {
		return []string{}, nil
	}
	sqlText, args := oracleListSchemasSQLWithVisibleSchemas(visibleSchemas)
	rows, err := s.queryRows(sqlText, args)
	if err != nil {
		if isOraclePGALimitError(err) {
			databases, fallbackErr := s.currentSchemaDatabase()
			if fallbackErr != nil {
				return nil, fallbackErr
			}
			result := make([]string, 0, len(databases))
			for _, database := range databases {
				result = append(result, database.Name)
			}
			return emptyIfNil(result), nil
		}
		return nil, err
	}
	defer s.closeRows(rows)
	var result []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		result = append(result, name)
	}
	if err := rows.Err(); err != nil {
		if isOraclePGALimitError(err) {
			databases, fallbackErr := s.currentSchemaDatabase()
			if fallbackErr != nil {
				return nil, fallbackErr
			}
			result = result[:0]
			for _, database := range databases {
				result = append(result, database.Name)
			}
			return emptyIfNil(result), nil
		}
		return nil, err
	}
	return emptyIfNil(result), nil
}

func (s *server) listDatabasesFiltered(visibleSchemas []string) ([]databaseInfo, error) {
	if visibleSchemas == nil {
		return s.listDatabases()
	}
	sqlText, args := oracleListDatabasesSQLWithVisibleSchemas(visibleSchemas)
	rows, err := s.queryRows(sqlText, args)
	if err != nil {
		if isOraclePGALimitError(err) {
			return s.currentSchemaDatabase()
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
	if err := rows.Err(); err != nil {
		if isOraclePGALimitError(err) {
			return s.currentSchemaDatabase()
		}
		return nil, err
	}
	return emptyIfNil(result), nil
}

func oracleListDatabasesSQLWithVisibleSchemas(visibleSchemas []string) (string, []any) {
	return oracleListSQLWithVisibleSchemas(oracleListDatabasesSQL, visibleSchemas)
}

func oracleListSchemasSQLWithVisibleSchemas(visibleSchemas []string) (string, []any) {
	return oracleListSQLWithVisibleSchemas(oracleListSchemasSQL, visibleSchemas)
}

func oracleListSQLWithVisibleSchemas(baseSQL string, visibleSchemas []string) (string, []any) {
	if len(visibleSchemas) == 0 {
		return baseSQL, nil
	}
	placeholders := make([]string, 0, len(visibleSchemas))
	args := make([]any, 0, len(visibleSchemas))
	for i, schema := range visibleSchemas {
		placeholders = append(placeholders, fmt.Sprintf(":%d", i+1))
		args = append(args, schema)
	}
	sqlText := strings.Replace(
		baseSQL,
		"\nORDER BY CASE",
		"\n  AND username IN ("+strings.Join(placeholders, ",")+")\nORDER BY CASE",
		1,
	)
	return sqlText, args
}

func (s *server) currentSchema() (string, error) {
	db, err := s.requireDB()
	if err != nil {
		return "", err
	}
	var schema string
	if err := db.QueryRow("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL").Scan(&schema); err != nil {
		return "", err
	}
	return strings.ToUpper(schema), nil
}

func (s *server) normalizeSchema(schema string) (string, error) {
	return resolveOracleSchema(schema, s.currentSchema, s.sessionUser)
}

func resolveOracleSchema(schema string, currentSchema, sessionUser func() (string, error)) (string, error) {
	if schema = strings.TrimSpace(schema); schema != "" {
		return strings.ToUpper(schema), nil
	}
	if current, err := currentSchema(); err == nil && strings.TrimSpace(current) != "" {
		return strings.ToUpper(strings.TrimSpace(current)), nil
	}
	return sessionUser()
}

func (s *server) sessionUser() (string, error) {
	db, err := s.requireDB()
	if err != nil {
		return "", err
	}
	var username string
	if err := db.QueryRow("SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') FROM DUAL").Scan(&username); err != nil {
		return "", err
	}
	return strings.ToUpper(username), nil
}

func (s *server) schemaIsSessionUser(schema string) bool {
	username, err := s.sessionUser()
	return err == nil && strings.EqualFold(schema, username)
}

type oracleMetadataListQuery struct {
	SQL  string
	Args []any
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

func oracleListTablesQuery(schema string, constraints metadataListConstraints) oracleMetadataListQuery {
	return oracleConstrainedMetadataListQuery(
		oracleListTablesBaseSQL,
		"OBJECT_NAME, TABLE_TYPE, COMMENTS",
		"TABLE_TYPE",
		oracleListTablesOrderSQL,
		[]any{schema, schema},
		constraints,
	)
}

func oracleListSessionUserTablesQuery(constraints metadataListConstraints) oracleMetadataListQuery {
	return oracleConstrainedMetadataListQuery(
		oracleListTablesSessionUserBaseSQL,
		"OBJECT_NAME, TABLE_TYPE, COMMENTS",
		"TABLE_TYPE",
		oracleListTablesOrderSQL,
		nil,
		constraints,
	)
}

func oracleListObjectsQuery(schema string, constraints metadataListConstraints) oracleMetadataListQuery {
	return oracleConstrainedMetadataListQuery(
		oracleListObjectsBaseSQL,
		"OBJECT_NAME, OBJECT_TYPE, COMMENTS",
		"OBJECT_TYPE",
		oracleListObjectsOrderSQL,
		[]any{schema, schema},
		constraints,
	)
}

func oracleListSessionUserObjectsQuery(constraints metadataListConstraints) oracleMetadataListQuery {
	return oracleConstrainedMetadataListQuery(
		oracleListObjectsSessionUserBaseSQL,
		"OBJECT_NAME, OBJECT_TYPE, COMMENTS",
		"OBJECT_TYPE",
		oracleListObjectsOrderSQL,
		nil,
		constraints,
	)
}

func oracleConstrainedMetadataListQuery(baseSQL, selectList, typeColumn, orderSQL string, baseArgs []any, constraints metadataListConstraints) oracleMetadataListQuery {
	args := append([]any{}, baseArgs...)
	where := make([]string, 0, 2)
	if filter := strings.TrimSpace(constraints.Filter); filter != "" {
		args = append(args, strings.ToUpper(oracleFuzzyLikePattern(filter)))
		where = append(where, fmt.Sprintf("UPPER(OBJECT_NAME) LIKE :%d ESCAPE '\\'", len(args)))
	}
	if objectTypes := normalizedMetadataObjectTypes(constraints.ObjectTypes); len(objectTypes) > 0 {
		placeholders := make([]string, 0, len(objectTypes))
		for _, objectType := range objectTypes {
			args = append(args, objectType)
			placeholders = append(placeholders, fmt.Sprintf(":%d", len(args)))
		}
		where = append(where, fmt.Sprintf("%s IN (%s)", typeColumn, strings.Join(placeholders, ",")))
	}

	sqlText := fmt.Sprintf("SELECT %s\nFROM (\n%s\n)", selectList, baseSQL)
	if len(where) > 0 {
		sqlText += "\nWHERE " + strings.Join(where, " AND ")
	}
	sqlText += "\n" + orderSQL

	if constraints.Limit > 0 {
		args = append(args, constraints.Offset+constraints.Limit)
		maxRowParam := len(args)
		args = append(args, constraints.Offset)
		offsetParam := len(args)
		sqlText = fmt.Sprintf(
			"SELECT %s\nFROM (\n  SELECT DBX_Q.*, ROWNUM AS DBX_RN\n  FROM (\n%s\n  ) DBX_Q\n  WHERE ROWNUM <= :%d\n)\nWHERE DBX_RN > :%d",
			selectList,
			sqlText,
			maxRowParam,
			offsetParam,
		)
	} else if constraints.Offset > 0 {
		args = append(args, constraints.Offset)
		offsetParam := len(args)
		sqlText = fmt.Sprintf(
			"SELECT %s\nFROM (\n  SELECT DBX_Q.*, ROWNUM AS DBX_RN\n  FROM (\n%s\n  ) DBX_Q\n)\nWHERE DBX_RN > :%d",
			selectList,
			sqlText,
			offsetParam,
		)
	}

	return oracleMetadataListQuery{SQL: sqlText, Args: args}
}

func normalizedMetadataObjectTypes(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		normalized := strings.ToUpper(strings.TrimSpace(value))
		normalized = strings.ReplaceAll(normalized, "-", "_")
		normalized = strings.ReplaceAll(normalized, " ", "_")
		if normalized == "" || seen[normalized] {
			continue
		}
		seen[normalized] = true
		result = append(result, normalized)
	}
	sort.Strings(result)
	return result
}

func oracleFuzzyLikePattern(value string) string {
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

func (s *server) listTables(schema string, constraints metadataListConstraints) ([]tableInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	query := oracleListTablesQuery(schema, constraints)
	if s.schemaIsSessionUser(schema) {
		query = oracleListSessionUserTablesQuery(constraints)
	}
	rows, err := s.queryRows(query.SQL, query.Args)
	if err != nil {
		if isOraclePGALimitError(err) {
			return []tableInfo{}, nil
		}
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
	query := oracleListObjectsQuery(schema, constraints)
	if s.schemaIsSessionUser(schema) {
		query = oracleListSessionUserObjectsQuery(constraints)
	}
	rows, err := s.queryRows(query.SQL, query.Args)
	if err != nil {
		if isOraclePGALimitError(err) {
			return []objectInfo{}, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)
	var result []objectInfo
	for rows.Next() {
		var item objectInfo
		item.Schema = schema
		if err := rows.Scan(&item.Name, &item.ObjectType, &item.Comment); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) completionAssistantSearch(request completionAssistantRequest) (completionAssistantResponse, error) {
	limit := request.MaxResults
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	preferredSchema := strings.ToUpper(strings.TrimSpace(request.Schema))
	if preferredSchema == "" {
		var err error
		preferredSchema, err = s.currentSchema()
		if err != nil {
			return completionAssistantResponse{}, err
		}
	}

	if completionRequestHasTableLikeKind(request.ObjectKinds) {
		return s.completionAssistantTables(request, preferredSchema, limit)
	}
	if completionRequestHasRoutineKind(request.ObjectKinds) {
		return s.completionAssistantRoutines(request, preferredSchema, limit)
	}
	return completionAssistantResponse{Candidates: []completionAssistantCandidate{}}, nil
}

func completionRequestHasTableLikeKind(kinds []string) bool {
	if len(kinds) == 0 {
		return true
	}
	for _, kind := range kinds {
		switch strings.ToLower(strings.TrimSpace(kind)) {
		case "table", "view":
			return true
		}
	}
	return false
}

func completionRequestHasRoutineKind(kinds []string) bool {
	for _, kind := range kinds {
		switch strings.ToLower(strings.TrimSpace(kind)) {
		case "routine", "procedure", "function":
			return true
		}
	}
	return false
}

func (s *server) completionAssistantTables(request completionAssistantRequest, preferredSchema string, limit int) (completionAssistantResponse, error) {
	scanLimit := limit * 3
	if scanLimit < limit+1 {
		scanLimit = limit + 1
	}
	if scanLimit > 1000 {
		scanLimit = 1000
	}
	query := oracleCompletionTablesQuery(request, preferredSchema, scanLimit+1)
	rows, err := s.queryRows(query.SQL, query.Args)
	if err != nil {
		return completionAssistantResponse{}, err
	}

	type tableRow struct {
		owner, name, objectType string
		targetOwner, targetName sql.NullString
	}
	rawRows := make([]tableRow, 0, scanLimit+1)
	targets := make([]oracleCompletionSynonymTarget, 0)
	for rows.Next() {
		var row tableRow
		if err := rows.Scan(&row.owner, &row.name, &row.objectType, &row.targetOwner, &row.targetName); err != nil {
			s.closeRows(rows)
			return completionAssistantResponse{}, err
		}
		rawRows = append(rawRows, row)
		if strings.EqualFold(row.objectType, "SYNONYM") && row.targetOwner.Valid && row.targetName.Valid {
			targets = append(targets, oracleCompletionSynonymTarget{Owner: row.targetOwner.String, Name: row.targetName.String})
		}
	}
	rowsErr := rows.Err()
	closeErr := s.closeRows(rows)
	if rowsErr != nil {
		return completionAssistantResponse{}, rowsErr
	}
	if closeErr != nil {
		return completionAssistantResponse{}, closeErr
	}

	validTargets, err := s.oracleCompletionValidSynonymTargets(targets, oracleCompletionTableObjectTypes(request.ObjectKinds))
	if err != nil {
		return completionAssistantResponse{}, err
	}
	candidates := make([]completionAssistantCandidate, 0, limit+1)
	for _, row := range rawRows {
		if strings.EqualFold(row.objectType, "SYNONYM") {
			if !row.targetOwner.Valid || !row.targetName.Valid {
				continue
			}
			if _, ok := validTargets[oracleCompletionSynonymTargetKey(row.targetOwner.String, row.targetName.String)]; !ok {
				continue
			}
		}
		kind := "table"
		if strings.EqualFold(row.objectType, "VIEW") {
			kind = "view"
		}
		candidates = append(candidates, completionAssistantCandidate{
			Name:     row.name,
			Kind:     kind,
			Database: stringPointer(request.Database),
			Schema:   stringPointer(row.owner),
			DataType: stringPointer(row.objectType),
		})
	}
	incomplete := len(candidates) > limit || len(rawRows) > scanLimit
	if incomplete {
		if len(candidates) > limit {
			candidates = candidates[:limit]
		}
	}
	return completionAssistantResponse{Candidates: candidates, Incomplete: incomplete}, nil
}

type oracleCompletionSynonymTarget struct {
	Owner string
	Name  string
}

func oracleCompletionSynonymTargetKey(owner, name string) string {
	return owner + "\x00" + name
}

func (s *server) oracleCompletionValidSynonymTargets(targets []oracleCompletionSynonymTarget, objectTypes []string) (map[string]struct{}, error) {
	unique := make([]oracleCompletionSynonymTarget, 0, len(targets))
	seen := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		key := oracleCompletionSynonymTargetKey(target.Owner, target.Name)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, target)
	}

	valid := make(map[string]struct{}, len(unique))
	const batchSize = 100
	for start := 0; start < len(unique); start += batchSize {
		end := start + batchSize
		if end > len(unique) {
			end = len(unique)
		}
		query := oracleCompletionSynonymTargetsQuery(unique[start:end], objectTypes)
		rows, err := s.queryRows(query.SQL, query.Args)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var owner, name string
			if err := rows.Scan(&owner, &name); err != nil {
				s.closeRows(rows)
				return nil, err
			}
			valid[oracleCompletionSynonymTargetKey(owner, name)] = struct{}{}
		}
		rowsErr := rows.Err()
		closeErr := s.closeRows(rows)
		if rowsErr != nil {
			return nil, rowsErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
	}
	return valid, nil
}

func (s *server) completionAssistantRoutines(request completionAssistantRequest, preferredSchema string, limit int) (completionAssistantResponse, error) {
	query := oracleCompletionRoutinesQuery(request, preferredSchema, limit+1)
	rows, err := s.queryRows(query.SQL, query.Args)
	if err != nil {
		return completionAssistantResponse{}, err
	}
	defer s.closeRows(rows)

	candidates := make([]completionAssistantCandidate, 0, limit+1)
	for rows.Next() {
		var owner, name, objectType string
		var parentName sql.NullString
		if err := rows.Scan(&owner, &name, &objectType, &parentName); err != nil {
			return completionAssistantResponse{}, err
		}
		kind := strings.ToLower(objectType)
		if objectType == "PACKAGE" {
			kind = "object"
		}
		candidate := completionAssistantCandidate{
			Name:     name,
			Kind:     kind,
			Database: stringPointer(request.Database),
			Schema:   stringPointer(owner),
			DataType: stringPointer(objectType),
		}
		if parentName.Valid {
			candidate.ParentSchema = stringPointer(owner)
			candidate.ParentName = stringPointer(parentName.String)
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return completionAssistantResponse{}, err
	}
	incomplete := len(candidates) > limit
	if incomplete {
		candidates = candidates[:limit]
	}
	return completionAssistantResponse{Candidates: candidates, Incomplete: incomplete}, nil
}

func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	result := value
	return &result
}

func oracleCompletionTableObjectTypes(kinds []string) []string {
	objectTypes := make([]string, 0, 2)
	for _, kind := range kinds {
		switch strings.ToLower(strings.TrimSpace(kind)) {
		case "table":
			objectTypes = append(objectTypes, "'TABLE'")
		case "view":
			objectTypes = append(objectTypes, "'VIEW'")
		}
	}
	if len(objectTypes) == 0 {
		objectTypes = []string{"'TABLE'", "'VIEW'"}
	}
	return objectTypes
}

func oracleCompletionTablesQuery(request completionAssistantRequest, preferredSchema string, limit int) oracleMetadataListQuery {
	objectTypes := oracleCompletionTableObjectTypes(request.ObjectKinds)
	pattern := oracleCompletionLikePattern(request.Mask, request.MatchMode)
	args := make([]any, 0, 7)
	args = append(args, pattern)
	objectNamePredicate := oracleCompletionNamePredicate("o.OBJECT_NAME", len(args), request.CaseSensitive)
	objectOwnerPredicate := ""
	synonymOwnerPredicate := ""
	owner := ""
	if !request.GlobalSearch {
		owner = strings.ToUpper(strings.TrimSpace(request.ParentSchema))
		if owner == "" {
			owner = strings.ToUpper(strings.TrimSpace(request.Schema))
		}
		if owner == "" {
			owner = preferredSchema
		}
		args = append(args, owner)
		objectOwnerPredicate = fmt.Sprintf(" AND o.OWNER = :%d", len(args))
	}
	args = append(args, pattern)
	synonymNamePredicate := oracleCompletionNamePredicate("s.SYNONYM_NAME", len(args), request.CaseSensitive)
	if owner != "" {
		args = append(args, owner)
		synonymOwnerPredicate = fmt.Sprintf(" AND s.OWNER = :%d", len(args))
	}
	args = append(args, preferredSchema)
	preferredParam := len(args)
	args = append(args, strings.TrimSpace(request.Mask))
	exactParam := len(args)
	args = append(args, limit)
	limitParam := len(args)

	baseSQL := fmt.Sprintf(`SELECT o.OWNER,
       o.OBJECT_NAME,
       o.OBJECT_TYPE,
       CAST(NULL AS VARCHAR2(128)) AS TARGET_OWNER,
       CAST(NULL AS VARCHAR2(128)) AS TARGET_NAME
  FROM ALL_OBJECTS o
  WHERE o.OBJECT_TYPE IN (%s)
    AND %s%s
  UNION ALL
  SELECT s.OWNER,
       s.SYNONYM_NAME AS OBJECT_NAME,
       'SYNONYM' AS OBJECT_TYPE,
       s.TABLE_OWNER AS TARGET_OWNER,
       s.TABLE_NAME AS TARGET_NAME
  FROM ALL_SYNONYMS s
	WHERE s.DB_LINK IS NULL
	    AND %s%s`, strings.Join(objectTypes, ","), objectNamePredicate, objectOwnerPredicate, synonymNamePredicate, synonymOwnerPredicate)
	unionSQL := fmt.Sprintf("SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, TARGET_OWNER, TARGET_NAME\nFROM (\n%s\n)", baseSQL)
	orderedSQL := oracleCompletionOrderedSQL(unionSQL, "OBJECT_NAME", "OBJECT_TYPE", preferredParam, exactParam)
	return oracleMetadataListQuery{
		SQL:  fmt.Sprintf("SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, TARGET_OWNER, TARGET_NAME FROM (\n%s\n) WHERE ROWNUM <= :%d", orderedSQL, limitParam),
		Args: args,
	}
}

func oracleCompletionSynonymTargetsQuery(targets []oracleCompletionSynonymTarget, objectTypes []string) oracleMetadataListQuery {
	args := make([]any, 0, len(targets)*2)
	predicates := make([]string, 0, len(targets))
	for _, target := range targets {
		args = append(args, target.Owner, target.Name)
		predicates = append(predicates, fmt.Sprintf("(o.OWNER = :%d AND o.OBJECT_NAME = :%d)", len(args)-1, len(args)))
	}
	return oracleMetadataListQuery{
		SQL:  fmt.Sprintf("SELECT DISTINCT o.OWNER, o.OBJECT_NAME\nFROM ALL_OBJECTS o\nWHERE o.OBJECT_TYPE IN (%s)\n  AND (%s)", strings.Join(objectTypes, ","), strings.Join(predicates, " OR ")),
		Args: args,
	}
}

func oracleCompletionRoutinesQuery(request completionAssistantRequest, preferredSchema string, limit int) oracleMetadataListQuery {
	pattern := oracleCompletionLikePattern(request.Mask, request.MatchMode)
	args := make([]any, 0, 6)
	baseSQL := `
SELECT o.OWNER, o.OBJECT_NAME, o.OBJECT_TYPE, CAST(NULL AS VARCHAR2(128)) AS PARENT_NAME
FROM ALL_OBJECTS o
WHERE o.OBJECT_TYPE IN ('FUNCTION', 'PROCEDURE', 'PACKAGE')`
	if parentName := strings.ToUpper(strings.TrimSpace(request.ParentName)); parentName != "" {
		args = append(args, parentName)
		parentParam := len(args)
		baseSQL = fmt.Sprintf(`
SELECT p.OWNER,
       p.PROCEDURE_NAME AS OBJECT_NAME,
       CASE WHEN EXISTS (
         SELECT 1
         FROM ALL_ARGUMENTS a
         WHERE a.OWNER = p.OWNER
           AND a.OBJECT_ID = p.OBJECT_ID
           AND a.SUBPROGRAM_ID = p.SUBPROGRAM_ID
           AND a.POSITION = 0
       ) THEN 'FUNCTION' ELSE 'PROCEDURE' END AS OBJECT_TYPE,
       p.OBJECT_NAME AS PARENT_NAME
FROM ALL_PROCEDURES p
WHERE p.OBJECT_TYPE = 'PACKAGE'
  AND p.PROCEDURE_NAME IS NOT NULL
  AND p.OBJECT_NAME = :%d`, parentParam)
	}
	args = append(args, pattern)
	nameParam := len(args)

	ownerPredicate := ""
	if !request.GlobalSearch {
		owner := strings.ToUpper(strings.TrimSpace(request.ParentSchema))
		if owner == "" {
			owner = strings.ToUpper(strings.TrimSpace(request.Schema))
		}
		if owner == "" {
			owner = preferredSchema
		}
		args = append(args, owner)
		ownerPredicate = fmt.Sprintf(" AND OWNER = :%d", len(args))
	}
	args = append(args, preferredSchema)
	preferredParam := len(args)
	args = append(args, strings.TrimSpace(request.Mask))
	exactParam := len(args)
	args = append(args, limit)
	limitParam := len(args)

	filteredSQL := fmt.Sprintf("SELECT DISTINCT OWNER, OBJECT_NAME, OBJECT_TYPE, PARENT_NAME\nFROM (\n%s\n)\nWHERE %s%s", baseSQL, oracleCompletionNamePredicate("OBJECT_NAME", nameParam, request.CaseSensitive), ownerPredicate)
	orderedSQL := oracleCompletionOrderedSQL(filteredSQL, "OBJECT_NAME", "OBJECT_TYPE", preferredParam, exactParam)
	return oracleMetadataListQuery{
		SQL:  fmt.Sprintf("SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, PARENT_NAME FROM (\n%s\n) WHERE ROWNUM <= :%d", orderedSQL, limitParam),
		Args: args,
	}
}

func oracleCompletionNamePredicate(column string, parameter int, caseSensitive bool) string {
	if caseSensitive {
		return fmt.Sprintf("%s LIKE :%d ESCAPE '\\'", column, parameter)
	}
	return fmt.Sprintf("UPPER(%s) LIKE UPPER(:%d) ESCAPE '\\'", column, parameter)
}

func oracleCompletionLikePattern(mask, matchMode string) string {
	escaped := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(strings.TrimSpace(mask))
	if strings.EqualFold(strings.TrimSpace(matchMode), "contains") {
		return "%" + escaped + "%"
	}
	return escaped + "%"
}

func oracleCompletionOrderedSQL(baseSQL, nameColumn, typeColumn string, preferredParam, exactParam int) string {
	return fmt.Sprintf(`%s
ORDER BY CASE
           WHEN OWNER = :%d THEN 0
           WHEN OWNER = 'PUBLIC' THEN 1
           WHEN OWNER IN ('SYS','SYSTEM','SYSMAN','DBSNMP','OUTLN','XDB','MDSYS','CTXSYS','WMSYS') THEN 3
           ELSE 2
         END,
         CASE WHEN UPPER(%s) = UPPER(:%d) THEN 0 ELSE 1 END,
         CASE %s WHEN 'TABLE' THEN 0 WHEN 'VIEW' THEN 1 WHEN 'FUNCTION' THEN 0 WHEN 'PROCEDURE' THEN 1 WHEN 'PACKAGE' THEN 2 WHEN 'SYNONYM' THEN 3 ELSE 4 END,
         %s,
         OWNER`, baseSQL, preferredParam, nameColumn, exactParam, typeColumn, nameColumn)
}

func (s *server) getColumns(schema, table string) ([]columnInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	table = strings.ToUpper(strings.TrimSpace(table))
	rows, err := s.queryRows(`
SELECT c.COLUMN_NAME,
       c.DATA_TYPE,
       c.NULLABLE,
       c.DATA_DEFAULT,
       CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS IS_PRIMARY_KEY,
       cc.COMMENTS,
       c.DATA_PRECISION,
       c.DATA_SCALE,
       c.CHAR_LENGTH
FROM ALL_TAB_COLUMNS c
LEFT JOIN (
  SELECT acc.OWNER, acc.TABLE_NAME, acc.COLUMN_NAME
  FROM ALL_CONSTRAINTS ac
  JOIN ALL_CONS_COLUMNS acc ON acc.OWNER = ac.OWNER AND acc.CONSTRAINT_NAME = ac.CONSTRAINT_NAME
  WHERE ac.CONSTRAINT_TYPE = 'P'
) pk ON pk.OWNER = c.OWNER AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
LEFT JOIN ALL_COL_COMMENTS cc ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME
WHERE c.OWNER = :1 AND c.TABLE_NAME = :2
ORDER BY c.COLUMN_ID`, []any{schema, table})
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var result []columnInfo
	for rows.Next() {
		var item columnInfo
		var nullable string
		var primary int
		if err := rows.Scan(
			&item.Name,
			&item.DataType,
			&nullable,
			&item.ColumnDefault,
			&primary,
			&item.Comment,
			&item.NumericPrecision,
			&item.NumericScale,
			&item.CharacterMaximumLength,
		); err != nil {
			return nil, err
		}
		item.IsNullable = nullable == "Y"
		item.IsPrimaryKey = primary != 0
		item.DataType = oracleColumnTypeDDL(item)
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) loadOracleColumnMeta(schema, table string) ([]oracleColumnMeta, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	table = strings.ToUpper(strings.TrimSpace(table))
	rows, err := s.queryRows(`
SELECT COLUMN_NAME, DATA_TYPE
FROM ALL_TAB_COLUMNS
WHERE OWNER = :1 AND TABLE_NAME = :2
ORDER BY COLUMN_ID`, []any{schema, table})
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var result []oracleColumnMeta
	for rows.Next() {
		var item oracleColumnMeta
		if err := rows.Scan(&item.Name, &item.DataType); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *server) listIndexes(schema, table string) ([]indexInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	table = strings.ToUpper(strings.TrimSpace(table))
	rows, err := s.queryRows(`
SELECT i.INDEX_NAME,
       ic.COLUMN_NAME,
       i.UNIQUENESS,
       CASE WHEN pk.CONSTRAINT_NAME IS NULL THEN 0 ELSE 1 END AS IS_PRIMARY,
       i.INDEX_TYPE,
       ic.COLUMN_POSITION
FROM ALL_INDEXES i
JOIN ALL_IND_COLUMNS ic ON ic.INDEX_OWNER = i.OWNER AND ic.INDEX_NAME = i.INDEX_NAME
LEFT JOIN ALL_CONSTRAINTS pk ON pk.OWNER = i.TABLE_OWNER
  AND pk.TABLE_NAME = i.TABLE_NAME
  AND pk.CONSTRAINT_TYPE = 'P'
  AND pk.INDEX_NAME = i.INDEX_NAME
WHERE i.TABLE_OWNER = :1 AND i.TABLE_NAME = :2
ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION`, []any{schema, table})
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)

	byName := map[string]*indexInfo{}
	order := []string{}
	for rows.Next() {
		var name, column, uniqueness, indexType string
		var primary int
		var position int
		if err := rows.Scan(&name, &column, &uniqueness, &primary, &indexType, &position); err != nil {
			return nil, err
		}
		item := byName[name]
		if item == nil {
			item = &indexInfo{
				Name:            name,
				Columns:         []string{},
				IsUnique:        uniqueness == "UNIQUE",
				IsPrimary:       primary != 0,
				IndexType:       &indexType,
				IncludedColumns: []string{},
			}
			byName[name] = item
			order = append(order, name)
		}
		item.Columns = append(item.Columns, column)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := make([]indexInfo, 0, len(order))
	for _, name := range order {
		result = append(result, *byName[name])
	}
	return emptyIfNil(result), nil
}

func (s *server) listForeignKeys(schema, table string) ([]foreignKeyInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	table = strings.ToUpper(strings.TrimSpace(table))
	rows, err := s.queryRows(`
SELECT ac.CONSTRAINT_NAME,
       acc.COLUMN_NAME,
       rcc.TABLE_NAME AS REF_TABLE,
       rcc.COLUMN_NAME AS REF_COLUMN
FROM ALL_CONSTRAINTS ac
JOIN ALL_CONS_COLUMNS acc ON acc.OWNER = ac.OWNER AND acc.CONSTRAINT_NAME = ac.CONSTRAINT_NAME
JOIN ALL_CONS_COLUMNS rcc ON rcc.OWNER = ac.R_OWNER AND rcc.CONSTRAINT_NAME = ac.R_CONSTRAINT_NAME
  AND rcc.POSITION = acc.POSITION
WHERE ac.OWNER = :1
  AND ac.TABLE_NAME = :2
  AND ac.CONSTRAINT_TYPE = 'R'
ORDER BY ac.CONSTRAINT_NAME, acc.POSITION`, []any{schema, table})
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var result []foreignKeyInfo
	for rows.Next() {
		var item foreignKeyInfo
		if err := rows.Scan(&item.Name, &item.Column, &item.RefTable, &item.RefColumn); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) listTriggers(schema, table string) ([]triggerInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	table = strings.ToUpper(strings.TrimSpace(table))
	rows, err := s.queryRows(oracleListTriggersSQL, []any{schema, table})
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var result []triggerInfo
	var currentName string
	var currentDescription string
	var source strings.Builder
	flush := func() {
		if len(result) == 0 || currentName == "" {
			return
		}
		if body, ok := oracleTriggerBody(source.String(), currentDescription); ok {
			result[len(result)-1].Statement = &body
		}
	}
	for rows.Next() {
		var name, event, timing string
		var description, lineText sql.NullString
		var line sql.NullInt64
		if err := rows.Scan(&name, &event, &timing, &description, &line, &lineText); err != nil {
			return nil, err
		}
		if name != currentName {
			flush()
			currentName = name
			currentDescription = description.String
			source.Reset()
			result = append(result, triggerInfo{Name: name, Event: event, Timing: timing})
		}
		if line.Valid && lineText.Valid {
			source.WriteString(lineText.String)
		}
	}
	flush()
	return emptyIfNil(result), rows.Err()
}

func oracleTriggerBody(source, description string) (string, bool) {
	source = strings.ReplaceAll(source, "\r\n", "\n")
	description = strings.ReplaceAll(description, "\r\n", "\n")
	if strings.TrimSpace(source) == "" {
		return "", false
	}

	sourceLines := strings.Split(source, "\n")
	descriptionLines := strings.Split(strings.TrimSpace(description), "\n")
	for len(descriptionLines) > 0 && strings.TrimSpace(descriptionLines[len(descriptionLines)-1]) == "" {
		descriptionLines = descriptionLines[:len(descriptionLines)-1]
	}
	if len(descriptionLines) > 0 && len(sourceLines) >= len(descriptionLines) {
		matches := true
		for index, descriptionLine := range descriptionLines {
			sourceLine := strings.TrimSpace(sourceLines[index])
			if index == 0 && len(sourceLine) >= len("TRIGGER") && strings.EqualFold(sourceLine[:len("TRIGGER")], "TRIGGER") {
				sourceLine = strings.TrimSpace(sourceLine[len("TRIGGER"):])
			}
			if !strings.EqualFold(sourceLine, strings.TrimSpace(descriptionLine)) {
				matches = false
				break
			}
		}
		if matches {
			return strings.TrimSpace(strings.Join(sourceLines[len(descriptionLines):], "\n")), true
		}
	}

	// ALL_SOURCE is still more useful than an empty editor if a database version formats DESCRIPTION differently.
	return strings.TrimSpace(source), true
}

func (s *server) getObjectSource(schema, name, objectType string) (map[string]any, error) {
	var err error
	schema, err = s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	upperType := strings.ToUpper(objectType)
	if upperType == "VIEW" {
		// ALL_VIEWS.TEXT for views — ALL_SOURCE doesn't contain views, and
		// DBMS_METADATA.GET_DDL fails on XE editions.
		var source string
		err = s.db.QueryRow(
			"SELECT TEXT FROM ALL_VIEWS WHERE OWNER = :1 AND VIEW_NAME = :2",
			schema, strings.ToUpper(name),
		).Scan(&source)
		if errors.Is(err, sql.ErrNoRows) {
			return map[string]any{"name": name, "object_type": objectType, "schema": schema, "source": ""}, nil
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"name": name, "object_type": objectType, "schema": schema, "source": source}, nil
	}

	rows, err := s.queryRows(`
SELECT TEXT
FROM ALL_SOURCE
WHERE OWNER = :1 AND NAME = :2 AND TYPE = :3
ORDER BY LINE`, []any{schema, strings.ToUpper(name), upperType})
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
	return map[string]any{"name": name, "object_type": objectType, "schema": schema, "source": builder.String()}, rows.Err()
}

func (s *server) getTableDDL(schema, table, objectType string) (string, error) {
	var err error
	schema, err = s.normalizeSchema(schema)
	if err != nil {
		return "", err
	}
	db, err := s.requireDB()
	if err != nil {
		return "", err
	}
	objectType, err = s.resolveDDLObjectType(schema, table, objectType)
	if err != nil {
		return "", err
	}
	if objectType == "VIEW" {
		return s.buildViewDDL(schema, table)
	}
	var ddl string
	err = db.QueryRow("SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) FROM DUAL", objectType, strings.ToUpper(table), schema).Scan(&ddl)
	if err == nil && strings.TrimSpace(ddl) != "" {
		return ddl, nil
	}
	if objectType == "TABLE" {
		return s.buildTableDDL(schema, table)
	}
	return "", err
}

func (s *server) resolveDDLObjectType(schema, name, requested string) (string, error) {
	objectType := normalizeDDLObjectType(requested)
	if objectType != "" {
		return objectType, nil
	}
	db, err := s.requireDB()
	if err != nil {
		return "", err
	}
	err = db.QueryRow(`
SELECT OBJECT_TYPE
FROM (
  SELECT OBJECT_TYPE
  FROM ALL_OBJECTS
  WHERE OWNER = :1
    AND OBJECT_NAME = :2
    AND OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')
  ORDER BY CASE OBJECT_TYPE WHEN 'TABLE' THEN 0 WHEN 'VIEW' THEN 1 ELSE 2 END
)
WHERE ROWNUM = 1`, schema, strings.ToUpper(name)).Scan(&objectType)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("object not found: %s.%s", schema, name)
	}
	if err != nil {
		return "", err
	}
	return normalizeDDLObjectType(objectType), nil
}

func normalizeDDLObjectType(value string) string {
	switch strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(value), " ", "_")) {
	case "TABLE":
		return "TABLE"
	case "VIEW":
		return "VIEW"
	case "MATERIALIZED_VIEW":
		return "MATERIALIZED_VIEW"
	default:
		return ""
	}
}

func (s *server) buildViewDDL(schema, name string) (string, error) {
	db, err := s.requireDB()
	if err != nil {
		return "", err
	}
	var source string
	err = db.QueryRow(
		"SELECT TEXT FROM ALL_VIEWS WHERE OWNER = :1 AND VIEW_NAME = :2",
		schema, strings.ToUpper(name),
	).Scan(&source)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("view not found: %s.%s", schema, name)
	}
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("CREATE OR REPLACE VIEW %s.%s AS\n%s", quoteIdentifier(schema), quoteIdentifier(name), strings.TrimSpace(source)), nil
}

func (s *server) buildTableDDL(schema, table string) (string, error) {
	columns, err := s.getColumns(schema, table)
	if err != nil {
		return "", err
	}
	if len(columns) == 0 {
		return "", fmt.Errorf("table not found: %s.%s", schema, table)
	}
	var builder strings.Builder
	builder.WriteString("CREATE TABLE ")
	builder.WriteString(quoteIdentifier(schema))
	builder.WriteByte('.')
	builder.WriteString(quoteIdentifier(table))
	builder.WriteString(" (\n")
	for i, column := range columns {
		if i > 0 {
			builder.WriteString(",\n")
		}
		builder.WriteString("  ")
		builder.WriteString(quoteIdentifier(column.Name))
		builder.WriteByte(' ')
		builder.WriteString(oracleColumnTypeDDL(column))
		if column.ColumnDefault != nil && strings.TrimSpace(*column.ColumnDefault) != "" {
			builder.WriteString(" DEFAULT ")
			builder.WriteString(strings.TrimSpace(*column.ColumnDefault))
		}
		if !column.IsNullable {
			builder.WriteString(" NOT NULL")
		}
	}
	primary := make([]string, 0)
	for _, column := range columns {
		if column.IsPrimaryKey {
			primary = append(primary, quoteIdentifier(column.Name))
		}
	}
	if len(primary) > 0 {
		builder.WriteString(",\n  PRIMARY KEY (")
		builder.WriteString(strings.Join(primary, ", "))
		builder.WriteByte(')')
	}
	builder.WriteString("\n)")
	return builder.String(), nil
}

func oracleColumnTypeDDL(column columnInfo) string {
	dataType := strings.ToUpper(strings.TrimSpace(column.DataType))
	if dataType == "" {
		return "VARCHAR2(4000)"
	}
	if strings.Contains(dataType, "(") {
		return dataType
	}
	if isOracleCharacterType(dataType) && column.CharacterMaximumLength != nil && *column.CharacterMaximumLength > 0 {
		return fmt.Sprintf("%s(%d)", dataType, *column.CharacterMaximumLength)
	}
	if dataType == "NUMBER" {
		if column.NumericPrecision != nil && *column.NumericPrecision > 0 {
			if column.NumericScale != nil && *column.NumericScale != 0 {
				return fmt.Sprintf("NUMBER(%d,%d)", *column.NumericPrecision, *column.NumericScale)
			}
			return fmt.Sprintf("NUMBER(%d)", *column.NumericPrecision)
		}
		return "NUMBER"
	}
	if (dataType == "FLOAT" || dataType == "BINARY_FLOAT" || dataType == "BINARY_DOUBLE") &&
		column.NumericPrecision != nil && *column.NumericPrecision > 0 {
		return fmt.Sprintf("%s(%d)", dataType, *column.NumericPrecision)
	}
	return dataType
}

func isOracleCharacterType(dataType string) bool {
	switch dataType {
	case "CHAR", "VARCHAR2", "VARCHAR", "NCHAR", "NVARCHAR2", "RAW":
		return true
	default:
		return false
	}
}

func (s *server) getExplainInfo(sqlText, database, schema string, timeoutSecs int) (string, error) {
	if strings.TrimSpace(sqlText) == "" {
		return "", errors.New("sql is required")
	}
	db, err := s.requireDB()
	if err != nil {
		return "", err
	}

	ctx := context.Background()
	var cancel context.CancelFunc
	if timeoutSecs > 0 {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(timeoutSecs)*time.Second)
	} else {
		ctx, cancel = context.WithCancel(ctx)
	}
	defer cancel()

	conn, err := db.Conn(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Close()

	targetSchema := strings.TrimSpace(schema)
	if targetSchema == "" && !strings.EqualFold(strings.TrimSpace(database), strings.TrimSpace(s.params.Database)) {
		targetSchema = strings.TrimSpace(database)
	}
	if targetSchema != "" {
		var originalSchema string
		if err := conn.QueryRowContext(ctx, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL").Scan(&originalSchema); err != nil {
			return "", err
		}
		if !strings.EqualFold(originalSchema, targetSchema) {
			if _, err := conn.ExecContext(ctx, "ALTER SESSION SET CURRENT_SCHEMA = "+quoteIdentifier(targetSchema)); err != nil {
				return "", err
			}
			defer restoreOracleCurrentSchema(conn, originalSchema)
		}
	}

	statementID := "DBX_" + strings.ToUpper(strconv.FormatInt(time.Now().UnixNano(), 36))
	defer cleanupOracleExplainPlan(conn, statementID)
	statementSQL := trimStatementSQL(sqlText)
	explainArgs := oracleExplainPlanBindArgs(statementSQL)
	if _, err := conn.ExecContext(ctx, "EXPLAIN PLAN SET STATEMENT_ID = '"+statementID+"' FOR "+statementSQL, explainArgs...); err != nil {
		return "", err
	}
	planRows, err := conn.QueryContext(
		ctx,
		"SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :1, 'TYPICAL +PREDICATE'))",
		statementID,
	)
	if err != nil {
		return "", err
	}
	defer planRows.Close()
	var builder strings.Builder
	for planRows.Next() {
		var line string
		if err := planRows.Scan(&line); err != nil {
			return "", err
		}
		builder.WriteString(line)
		builder.WriteByte('\n')
	}
	return strings.TrimSpace(builder.String()), planRows.Err()
}

func cleanupOracleExplainPlan(conn *sql.Conn, statementID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = conn.ExecContext(ctx, "DELETE FROM PLAN_TABLE WHERE STATEMENT_ID = :1", statementID)
}

type oracleBindParam struct {
	Name       string
	Positional bool
}

func oracleExplainPlanBindArgs(sqlText string) []any {
	params := oracleExplainPlanBindParams(sqlText)
	args := make([]any, 0, len(params))
	for _, param := range params {
		if param.Positional {
			args = append(args, nil)
			continue
		}
		args = append(args, sql.Named(param.Name, nil))
	}
	return args
}

func oracleExplainPlanBindParams(sqlText string) []oracleBindParam {
	params := make([]oracleBindParam, 0)
	seenNamed := map[string]bool{}
	for pos := 0; pos < len(sqlText); pos++ {
		switch sqlText[pos] {
		case '\'':
			pos = skipSingleQuotedSQL(sqlText, pos)
		case '"':
			pos = skipDoubleQuotedSQL(sqlText, pos)
		case 'q', 'Q':
			if end, ok := skipOracleAlternativeQuotedSQL(sqlText, pos); ok {
				pos = end
			}
		case '-':
			if pos+1 < len(sqlText) && sqlText[pos+1] == '-' {
				pos = skipLineCommentSQL(sqlText, pos)
			}
		case '/':
			if pos+1 < len(sqlText) && sqlText[pos+1] == '*' {
				pos = skipBlockCommentSQL(sqlText, pos)
			}
		case ':':
			param, end, ok := readOracleBindParam(sqlText, pos)
			if !ok {
				continue
			}
			if param.Positional {
				params = append(params, param)
			} else if key := strings.ToUpper(param.Name); !seenNamed[key] {
				seenNamed[key] = true
				params = append(params, param)
			}
			pos = end - 1
		}
	}
	return params
}

func readOracleBindParam(sqlText string, pos int) (oracleBindParam, int, bool) {
	if pos < 0 || pos+1 >= len(sqlText) || sqlText[pos] != ':' {
		return oracleBindParam{}, pos, false
	}
	if pos > 0 && sqlText[pos-1] == ':' {
		return oracleBindParam{}, pos, false
	}
	next := sqlText[pos+1]
	if next >= '0' && next <= '9' {
		end := pos + 2
		for end < len(sqlText) && sqlText[end] >= '0' && sqlText[end] <= '9' {
			end++
		}
		return oracleBindParam{Name: sqlText[pos+1 : end], Positional: true}, end, true
	}
	if !isOracleIdentifierStart(next) {
		return oracleBindParam{}, pos, false
	}
	end := pos + 2
	for end < len(sqlText) && isOracleIdentifierPart(sqlText[end]) {
		end++
	}
	return oracleBindParam{Name: sqlText[pos+1 : end]}, end, true
}

func restoreOracleCurrentSchema(conn *sql.Conn, schema string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = conn.ExecContext(ctx, "ALTER SESSION SET CURRENT_SCHEMA = "+quoteIdentifier(schema))
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
	tx, err := db.Begin()
	if err != nil {
		return queryResult{}, err
	}
	if strings.TrimSpace(payload.Schema) != "" {
		if _, err := tx.Exec("ALTER SESSION SET CURRENT_SCHEMA = " + quoteIdentifier(payload.Schema)); err != nil {
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
		result, err := tx.Exec(statement)
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
		Rows:            [][]any{},
		AffectedRows:    affected,
		ExecutionTimeMS: time.Since(start).Milliseconds(),
	}, nil
}

func (s *server) executeQueryPage(opts queryOptions, pageSize int) (queryPageResult, error) {
	start := time.Now()
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
	rows, err := s.queryRowsWithXMLTypeRewriteIfNeeded(sqlText, opts.TimeoutSecs)
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
	sessionID := fmt.Sprintf("oracle-go-%d", s.nextSessionID)
	s.sessions[sessionID] = session
	return sessionID
}

func (s *server) startTableRead(opts queryOptions, pageSize int) (queryPageResult, error) {
	start := time.Now()
	if strings.TrimSpace(opts.Schema) != "" {
		if err := s.setSchema(opts.Schema); err != nil {
			return queryPageResult{}, err
		}
	}
	sqlText := trimStatementSQL(opts.SQL)
	if !isQuerySQL(sqlText) {
		return queryPageResult{}, errors.New("table read requires a SELECT query")
	}
	rows, err := s.queryRowsWithXMLTypeRewriteIfNeeded(sqlText, opts.TimeoutSecs)
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
		sessionID := s.storeTableReadSession(session)
		result.SessionID = &sessionID
	} else {
		s.closeRows(rows)
	}
	return result, nil
}

func (s *server) fetchTableReadPage(sessionID string, pageSize int) (queryPageResult, error) {
	session := s.tableReadSessions[sessionID]
	if session == nil {
		return queryPageResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}, SessionID: nil, HasMore: false}, nil
	}
	result, err := readQuerySessionPage(session, pageSize)
	if err != nil {
		s.closeTableReadSession(sessionID)
		return queryPageResult{}, err
	}
	if result.HasMore {
		result.SessionID = &sessionID
	} else {
		s.closeTableReadSession(sessionID)
	}
	return result, nil
}

func (s *server) storeTableReadSession(session *querySession) string {
	s.nextTableReadSessionID++
	sessionID := fmt.Sprintf("oracle-go-table-%d", s.nextTableReadSessionID)
	s.tableReadSessions[sessionID] = session
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

func (s *server) closeTableReadSession(sessionID string) bool {
	session := s.tableReadSessions[sessionID]
	if session == nil {
		return false
	}
	s.closeRows(session.rows)
	delete(s.tableReadSessions, sessionID)
	return true
}

func (s *server) closeAllQuerySessions() {
	for sessionID := range s.sessions {
		s.closeQuerySession(sessionID)
	}
	for sessionID := range s.tableReadSessions {
		s.closeTableReadSession(sessionID)
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
		row, err := scanRow(session.rows, len(session.columns), session.columnTypes)
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
		row, err := scanRow(session.rows, len(session.columns), session.columnTypes)
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
	ctx, cancel := context.WithCancel(context.Background())
	var timer *time.Timer
	if opts.TimeoutSecs > 0 {
		var t *time.Timer
		t = time.AfterFunc(time.Duration(opts.TimeoutSecs)*time.Second, func() {
			s.activeCancelMu.Lock()
			if s.activeTimer == t {
				cancel()
			}
			s.activeCancelMu.Unlock()
		})
		timer = t
	}
	s.activeCancelMu.Lock()
	s.activeCancel = cancel
	s.activeTimer = timer
	s.activeCancelMu.Unlock()
	defer func() {
		cancel()
		s.activeCancelMu.Lock()
		s.activeCancel = nil
		if s.activeTimer != nil {
			s.activeTimer.Stop()
			s.activeTimer = nil
		}
		s.activeCancelMu.Unlock()
	}()
	execResult, err := db.ExecContext(ctx, sqlText)
	if err != nil {
		return queryResult{}, err
	}
	affected, _ := execResult.RowsAffected()
	return queryResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}, AffectedRows: affected, ExecutionTimeMS: time.Since(start).Milliseconds()}, nil
}

func (s *server) executeSelect(sqlText string, maxRows int, timeoutSecs int) (queryResult, error) {
	rows, err := s.queryRowsWithXMLTypeRewriteIfNeeded(sqlText, timeoutSecs)
	if err != nil {
		return queryResult{}, err
	}
	defer s.closeRows(rows)
	columns, err := rows.Columns()
	if err != nil {
		return queryResult{}, err
	}
	columnTypes := columnTypeNames(rows)
	result := queryResult{Columns: columns, ColumnTypes: columnTypes, Rows: [][]any{}}
	for rows.Next() {
		if len(result.Rows) >= maxRows {
			result.Truncated = true
			break
		}
		values, err := scanRow(rows, len(columns), columnTypes)
		if err != nil {
			return queryResult{}, err
		}
		result.Rows = append(result.Rows, values)
	}
	return result, rows.Err()
}

func scanRow(rows *sql.Rows, columnCount int, columnTypes []string) ([]any, error) {
	values := make([]any, columnCount)
	scanTargets := make([]any, columnCount)
	for i := range values {
		scanTargets[i] = &values[i]
	}
	if err := rows.Scan(scanTargets...); err != nil {
		return nil, err
	}
	for i, value := range values {
		values[i] = normalizeValue(value, columnTypeAt(columnTypes, i))
	}
	return values, nil
}

func columnTypeAt(columnTypes []string, index int) string {
	if index < 0 || index >= len(columnTypes) {
		return ""
	}
	return columnTypes[index]
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

func (s *server) queryRowsWithXMLTypeRewriteIfNeeded(sqlText string, timeoutSecs int) (*sql.Rows, error) {
	rows, err := s.queryRowsWithTimeout(sqlText, nil, timeoutSecs)
	if err != nil {
		return nil, err
	}
	if !rowsContainOracleXMLType(rows) {
		return rows, nil
	}
	rewritten, err := s.rewriteXMLTypeSelectSQL(sqlText)
	if err != nil {
		s.closeRows(rows)
		return nil, err
	}
	if rewritten == sqlText {
		return rows, nil
	}
	// Only pay the ALL_TAB_COLUMNS rewrite cost when the result metadata shows
	// XMLTYPE. Ordinary Oracle queries should not run dictionary probes first.
	s.closeRows(rows)
	return s.queryRowsWithTimeout(rewritten, nil, timeoutSecs)
}

func rowsContainOracleXMLType(rows *sql.Rows) bool {
	types, err := rows.ColumnTypes()
	if err != nil {
		return false
	}
	typeNames := make([]string, 0, len(types))
	for _, columnType := range types {
		typeNames = append(typeNames, columnType.DatabaseTypeName())
	}
	return oracleColumnTypeNamesContainXMLType(typeNames)
}

func oracleColumnTypeNamesContainXMLType(typeNames []string) bool {
	for _, typeName := range typeNames {
		if isOracleXMLType(typeName) {
			return true
		}
	}
	return false
}

func (s *server) rewriteXMLTypeSelectSQL(sqlText string) (string, error) {
	return rewriteOracleXMLTypeSelectSQL(sqlText, s.loadOracleColumnMeta)
}

func rewriteOracleXMLTypeSelectSQL(sqlText string, loadColumns oracleColumnMetaLoader) (string, error) {
	rewritten, _, err := rewriteOracleXMLTypeSelectSQLDepth(sqlText, loadColumns, 0)
	return rewritten, err
}

func rewriteOracleXMLTypeSelectSQLDepth(sqlText string, loadColumns oracleColumnMetaLoader, depth int) (string, bool, error) {
	if depth > 8 {
		return sqlText, false, nil
	}
	if rewritten, changed, handled, err := rewriteDirectOracleXMLTypeSelectSQL(sqlText, loadColumns); handled || err != nil {
		return rewritten, changed, err
	}
	rewritten, changed, err := rewriteNestedOracleSelects(sqlText, loadColumns, depth)
	return rewritten, changed, err
}

func rewriteNestedOracleSelects(sqlText string, loadColumns oracleColumnMetaLoader, depth int) (string, bool, error) {
	var builder strings.Builder
	changed := false
	last := 0
	for pos := 0; pos < len(sqlText); pos++ {
		switch sqlText[pos] {
		case '\'':
			pos = skipSingleQuotedSQL(sqlText, pos)
		case '"':
			pos = skipDoubleQuotedSQL(sqlText, pos)
		case '-':
			if pos+1 < len(sqlText) && sqlText[pos+1] == '-' {
				pos = skipLineCommentSQL(sqlText, pos)
			}
		case '/':
			if pos+1 < len(sqlText) && sqlText[pos+1] == '*' {
				pos = skipBlockCommentSQL(sqlText, pos)
			}
		case '(':
			end := findMatchingSQLParen(sqlText, pos)
			if end < 0 {
				return sqlText, false, nil
			}
			inner := sqlText[pos+1 : end]
			if startsWithSQLKeyword(trimLeadingSQLComments(inner), "select") {
				rewrittenInner, innerChanged, err := rewriteOracleXMLTypeSelectSQLDepth(inner, loadColumns, depth+1)
				if err != nil {
					return "", false, err
				}
				if innerChanged {
					builder.WriteString(sqlText[last : pos+1])
					builder.WriteString(rewrittenInner)
					last = end
					changed = true
				}
			}
			pos = end
		}
	}
	if !changed {
		return sqlText, false, nil
	}
	builder.WriteString(sqlText[last:])
	return builder.String(), true, nil
}

func rewriteDirectOracleXMLTypeSelectSQL(sqlText string, loadColumns oracleColumnMetaLoader) (string, bool, bool, error) {
	selectStart := leadingSQLSelectListStart(sqlText)
	if selectStart < 0 {
		return sqlText, false, false, nil
	}
	fromIdx := findTopLevelSQLKeyword(sqlText, selectStart, "from")
	if fromIdx < 0 {
		return sqlText, false, false, nil
	}
	selectListPrefix, selectList := splitOracleSelectListModifier(sqlText[selectStart:fromIdx])
	tableRef, ok := parseSingleOracleTableRef(sqlText[fromIdx+len("from"):])
	if !ok {
		return sqlText, false, false, nil
	}
	items := splitTopLevelSQLList(selectList)
	if len(items) == 0 || !oracleSelectListMayReferenceXMLType(items) {
		return sqlText, false, true, nil
	}
	columns, err := loadColumns(tableRef.Schema, tableRef.Table)
	if err != nil {
		return "", false, true, err
	}
	if !oracleColumnsHaveXMLType(columns) {
		return sqlText, false, true, nil
	}
	rewrittenItems, changed := rewriteOracleSelectItemsForXMLType(items, columns, tableRef)
	if !changed {
		return sqlText, false, true, nil
	}
	var builder strings.Builder
	builder.WriteString(sqlText[:selectStart])
	builder.WriteString(selectListPrefix)
	builder.WriteString(strings.Join(rewrittenItems, ", "))
	builder.WriteByte(' ')
	builder.WriteString(sqlText[fromIdx:])
	return builder.String(), true, true, nil
}

type oracleTableRef struct {
	Schema    string
	Table     string
	Alias     string
	AliasText string
}

type oracleIdentifierToken struct {
	Name   string
	Text   string
	Quoted bool
}

func parseSingleOracleTableRef(fromSQL string) (oracleTableRef, bool) {
	pos := skipSQLWhitespace(fromSQL, 0)
	if pos >= len(fromSQL) || fromSQL[pos] == '(' {
		return oracleTableRef{}, false
	}
	first, next, ok := readOracleIdentifierToken(fromSQL, pos)
	if !ok {
		return oracleTableRef{}, false
	}
	ref := oracleTableRef{Table: first.Name}
	pos = skipSQLWhitespace(fromSQL, next)
	if pos < len(fromSQL) && fromSQL[pos] == '.' {
		second, afterSecond, ok := readOracleIdentifierToken(fromSQL, skipSQLWhitespace(fromSQL, pos+1))
		if !ok {
			return oracleTableRef{}, false
		}
		ref.Schema = first.Name
		ref.Table = second.Name
		pos = skipSQLWhitespace(fromSQL, afterSecond)
	}
	if pos < len(fromSQL) {
		if strings.HasPrefix(strings.TrimLeft(fromSQL[pos:], " \t\r\n"), ",") {
			return oracleTableRef{}, false
		}
		if nextKeywordIsOracleClause(fromSQL[pos:]) {
			return ref, true
		}
		if startsWithSQLKeyword(fromSQL[pos:], "join") ||
			startsWithSQLKeyword(fromSQL[pos:], "inner") ||
			startsWithSQLKeyword(fromSQL[pos:], "left") ||
			startsWithSQLKeyword(fromSQL[pos:], "right") ||
			startsWithSQLKeyword(fromSQL[pos:], "full") ||
			startsWithSQLKeyword(fromSQL[pos:], "cross") {
			return oracleTableRef{}, false
		}
		alias, afterAlias, ok := readOracleIdentifierToken(fromSQL, pos)
		if ok && !oracleIdentifierIsClause(alias.Name) {
			ref.Alias = alias.Name
			ref.AliasText = alias.Text
			pos = skipSQLWhitespace(fromSQL, afterAlias)
		}
		if strings.HasPrefix(strings.TrimLeft(fromSQL[pos:], " \t\r\n"), ",") ||
			startsWithSQLKeyword(fromSQL[pos:], "join") ||
			startsWithSQLKeyword(fromSQL[pos:], "inner") ||
			startsWithSQLKeyword(fromSQL[pos:], "left") ||
			startsWithSQLKeyword(fromSQL[pos:], "right") ||
			startsWithSQLKeyword(fromSQL[pos:], "full") ||
			startsWithSQLKeyword(fromSQL[pos:], "cross") {
			return oracleTableRef{}, false
		}
	}
	return ref, true
}

func splitOracleSelectListModifier(selectList string) (string, string) {
	trimmedLeft := strings.TrimLeft(selectList, " \t\r\n")
	prefixLen := len(selectList) - len(trimmedLeft)
	for _, keyword := range []string{"distinct", "all"} {
		if startsWithSQLKeyword(trimmedLeft, keyword) {
			modifierEnd := prefixLen + len(keyword)
			for modifierEnd < len(selectList) && isSQLWhitespace(selectList[modifierEnd]) {
				modifierEnd++
			}
			return selectList[:modifierEnd], selectList[modifierEnd:]
		}
	}
	return selectList[:prefixLen], selectList[prefixLen:]
}

func oracleSelectListMayReferenceXMLType(items []string) bool {
	for _, item := range items {
		if _, ok := parseOracleStarSelectItem(item); ok {
			return true
		}
		if _, _, _, ok := parseOracleColumnSelectItem(item); ok {
			return true
		}
	}
	return false
}

func rewriteOracleSelectItemsForXMLType(items []string, columns []oracleColumnMeta, tableRef oracleTableRef) ([]string, bool) {
	xmlColumns := map[string]oracleColumnMeta{}
	for _, column := range columns {
		if isOracleXMLType(column.DataType) {
			xmlColumns[oracleIdentifierKey(column.Name)] = column
		}
	}
	rewritten := make([]string, 0, len(items))
	changed := false
	for _, item := range items {
		if qualifier, ok := parseOracleStarSelectItem(item); ok && oracleQualifierMatchesTable(qualifier, tableRef) {
			for _, column := range columns {
				rewritten = append(rewritten, oracleSelectExpressionForColumn(column, tableRef, xmlColumns))
			}
			changed = true
			continue
		}
		qualifier, column, alias, ok := parseOracleColumnSelectItem(item)
		if ok && oracleQualifierMatchesTable(qualifier, tableRef) {
			if meta, isXML := xmlColumns[oracleIdentifierKey(column.Name)]; isXML {
				outputAlias := alias
				if outputAlias == "" {
					outputAlias = quoteIdentifier(meta.Name)
				}
				rewritten = append(rewritten, oracleXMLSerializeExpression(oracleColumnRef(qualifier, meta.Name), outputAlias))
				changed = true
				continue
			}
		}
		rewritten = append(rewritten, item)
	}
	return rewritten, changed
}

func oracleSelectExpressionForColumn(column oracleColumnMeta, tableRef oracleTableRef, xmlColumns map[string]oracleColumnMeta) string {
	qualifier := ""
	if tableRef.AliasText != "" {
		qualifier = tableRef.AliasText
	}
	if _, isXML := xmlColumns[oracleIdentifierKey(column.Name)]; isXML {
		return oracleXMLSerializeExpression(oracleColumnRef(qualifier, column.Name), quoteIdentifier(column.Name))
	}
	return oracleColumnRef(qualifier, column.Name)
}

func oracleXMLSerializeExpression(columnRef, alias string) string {
	// go-ora v2.9.0 does not fully decode Oracle XMLTYPE result payloads,
	// especially when 11g switches larger values to locator-based transfer.
	return fmt.Sprintf("XMLSERIALIZE(CONTENT %s AS CLOB) AS %s", columnRef, alias)
}

func oracleColumnRef(qualifier, column string) string {
	if strings.TrimSpace(qualifier) == "" {
		return quoteIdentifier(column)
	}
	return qualifier + "." + quoteIdentifier(column)
}

func parseOracleStarSelectItem(item string) (string, bool) {
	trimmed := strings.TrimSpace(item)
	if trimmed == "*" {
		return "", true
	}
	qualifier, pos, ok := readOracleIdentifierToken(trimmed, 0)
	if !ok {
		return "", false
	}
	pos = skipSQLWhitespace(trimmed, pos)
	if pos >= len(trimmed) || trimmed[pos] != '.' {
		return "", false
	}
	pos = skipSQLWhitespace(trimmed, pos+1)
	if pos < len(trimmed) && trimmed[pos] == '*' && strings.TrimSpace(trimmed[pos+1:]) == "" {
		return qualifier.Text, true
	}
	return "", false
}

func parseOracleColumnSelectItem(item string) (qualifier string, column oracleIdentifierToken, alias string, ok bool) {
	trimmed := strings.TrimSpace(item)
	first, pos, ok := readOracleIdentifierToken(trimmed, 0)
	if !ok {
		return "", oracleIdentifierToken{}, "", false
	}
	column = first
	pos = skipSQLWhitespace(trimmed, pos)
	if pos < len(trimmed) && trimmed[pos] == '.' {
		second, afterSecond, ok := readOracleIdentifierToken(trimmed, skipSQLWhitespace(trimmed, pos+1))
		if !ok {
			return "", oracleIdentifierToken{}, "", false
		}
		qualifier = first.Text
		column = second
		pos = skipSQLWhitespace(trimmed, afterSecond)
	}
	if pos >= len(trimmed) {
		return qualifier, column, "", true
	}
	if startsWithSQLKeyword(trimmed[pos:], "as") {
		aliasToken, afterAlias, ok := readOracleIdentifierToken(trimmed, skipSQLWhitespace(trimmed, pos+len("as")))
		if !ok || strings.TrimSpace(trimmed[afterAlias:]) != "" {
			return "", oracleIdentifierToken{}, "", false
		}
		return qualifier, column, aliasToken.Text, true
	}
	aliasToken, afterAlias, ok := readOracleIdentifierToken(trimmed, pos)
	if !ok || strings.TrimSpace(trimmed[afterAlias:]) != "" {
		return "", oracleIdentifierToken{}, "", false
	}
	return qualifier, column, aliasToken.Text, true
}

func oracleQualifierMatchesTable(qualifier string, tableRef oracleTableRef) bool {
	if strings.TrimSpace(qualifier) == "" {
		return true
	}
	key := oracleIdentifierKey(unquoteOracleIdentifierText(qualifier))
	if tableRef.Alias != "" && key == oracleIdentifierKey(tableRef.Alias) {
		return true
	}
	return key == oracleIdentifierKey(tableRef.Table)
}

func oracleColumnsHaveXMLType(columns []oracleColumnMeta) bool {
	for _, column := range columns {
		if isOracleXMLType(column.DataType) {
			return true
		}
	}
	return false
}

func isOracleXMLType(dataType string) bool {
	normalized := strings.ToUpper(strings.TrimSpace(dataType))
	return normalized == "XMLTYPE" || normalized == "SYS.XMLTYPE"
}

func leadingSQLSelectListStart(sqlText string) int {
	trimmed := trimLeadingSQLComments(sqlText)
	prefixLen := len(sqlText) - len(trimmed)
	if !startsWithSQLKeyword(trimmed, "select") {
		return -1
	}
	return prefixLen + len("select")
}

func splitTopLevelSQLList(value string) []string {
	var result []string
	start := 0
	depth := 0
	for pos := 0; pos < len(value); pos++ {
		switch value[pos] {
		case '\'':
			pos = skipSingleQuotedSQL(value, pos)
		case '"':
			pos = skipDoubleQuotedSQL(value, pos)
		case '-':
			if pos+1 < len(value) && value[pos+1] == '-' {
				pos = skipLineCommentSQL(value, pos)
			}
		case '/':
			if pos+1 < len(value) && value[pos+1] == '*' {
				pos = skipBlockCommentSQL(value, pos)
			}
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		case ',':
			if depth == 0 {
				result = append(result, strings.TrimSpace(value[start:pos]))
				start = pos + 1
			}
		}
	}
	tail := strings.TrimSpace(value[start:])
	if tail != "" {
		result = append(result, tail)
	}
	return result
}

func findTopLevelSQLKeyword(sqlText string, start int, keyword string) int {
	depth := 0
	for pos := start; pos < len(sqlText); pos++ {
		switch sqlText[pos] {
		case '\'':
			pos = skipSingleQuotedSQL(sqlText, pos)
		case '"':
			pos = skipDoubleQuotedSQL(sqlText, pos)
		case '-':
			if pos+1 < len(sqlText) && sqlText[pos+1] == '-' {
				pos = skipLineCommentSQL(sqlText, pos)
			}
		case '/':
			if pos+1 < len(sqlText) && sqlText[pos+1] == '*' {
				pos = skipBlockCommentSQL(sqlText, pos)
			}
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		default:
			if depth == 0 && sqlKeywordAt(sqlText, pos, keyword) {
				return pos
			}
		}
	}
	return -1
}

func findMatchingSQLParen(sqlText string, open int) int {
	depth := 0
	for pos := open; pos < len(sqlText); pos++ {
		switch sqlText[pos] {
		case '\'':
			pos = skipSingleQuotedSQL(sqlText, pos)
		case '"':
			pos = skipDoubleQuotedSQL(sqlText, pos)
		case '-':
			if pos+1 < len(sqlText) && sqlText[pos+1] == '-' {
				pos = skipLineCommentSQL(sqlText, pos)
			}
		case '/':
			if pos+1 < len(sqlText) && sqlText[pos+1] == '*' {
				pos = skipBlockCommentSQL(sqlText, pos)
			}
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return pos
			}
		}
	}
	return -1
}

func readOracleIdentifierToken(value string, pos int) (oracleIdentifierToken, int, bool) {
	pos = skipSQLWhitespace(value, pos)
	if pos >= len(value) {
		return oracleIdentifierToken{}, pos, false
	}
	if value[pos] == '"' {
		end := pos + 1
		var builder strings.Builder
		for end < len(value) {
			if value[end] == '"' {
				if end+1 < len(value) && value[end+1] == '"' {
					builder.WriteByte('"')
					end += 2
					continue
				}
				return oracleIdentifierToken{Name: builder.String(), Text: value[pos : end+1], Quoted: true}, end + 1, true
			}
			builder.WriteByte(value[end])
			end++
		}
		return oracleIdentifierToken{}, pos, false
	}
	if !isOracleIdentifierStart(value[pos]) {
		return oracleIdentifierToken{}, pos, false
	}
	end := pos + 1
	for end < len(value) && isOracleIdentifierPart(value[end]) {
		end++
	}
	text := value[pos:end]
	return oracleIdentifierToken{Name: strings.ToUpper(text), Text: text}, end, true
}

func unquoteOracleIdentifierText(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		return strings.ReplaceAll(value[1:len(value)-1], `""`, `"`)
	}
	return strings.ToUpper(value)
}

func oracleIdentifierKey(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}

func oracleIdentifierIsClause(value string) bool {
	switch oracleIdentifierKey(value) {
	case "WHERE", "GROUP", "ORDER", "HAVING", "CONNECT", "START", "MODEL", "FETCH", "OFFSET", "UNION", "MINUS", "INTERSECT":
		return true
	default:
		return false
	}
}

func nextKeywordIsOracleClause(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return true
	}
	token, _, ok := readOracleIdentifierToken(trimmed, 0)
	return ok && oracleIdentifierIsClause(token.Name)
}

func isOracleIdentifierStart(ch byte) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch == '_' || ch == '$' || ch == '#'
}

func isOracleIdentifierPart(ch byte) bool {
	return isOracleIdentifierStart(ch) || (ch >= '0' && ch <= '9')
}

func skipSQLWhitespace(value string, pos int) int {
	for pos < len(value) && isSQLWhitespace(value[pos]) {
		pos++
	}
	return pos
}

func isSQLWhitespace(ch byte) bool {
	return ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n'
}

func skipSingleQuotedSQL(value string, pos int) int {
	pos++
	for pos < len(value) {
		if value[pos] == '\'' {
			if pos+1 < len(value) && value[pos+1] == '\'' {
				pos += 2
				continue
			}
			return pos
		}
		pos++
	}
	return len(value) - 1
}

func skipOracleAlternativeQuotedSQL(value string, pos int) (int, bool) {
	if pos+2 >= len(value) || (value[pos] != 'q' && value[pos] != 'Q') || value[pos+1] != '\'' {
		return pos, false
	}
	open := value[pos+2]
	close := open
	switch open {
	case '[':
		close = ']'
	case '{':
		close = '}'
	case '(':
		close = ')'
	case '<':
		close = '>'
	}
	for end := pos + 3; end+1 < len(value); end++ {
		if value[end] == close && value[end+1] == '\'' {
			return end + 1, true
		}
	}
	return len(value) - 1, true
}

func skipDoubleQuotedSQL(value string, pos int) int {
	pos++
	for pos < len(value) {
		if value[pos] == '"' {
			if pos+1 < len(value) && value[pos+1] == '"' {
				pos += 2
				continue
			}
			return pos
		}
		pos++
	}
	return len(value) - 1
}

func skipLineCommentSQL(value string, pos int) int {
	for pos < len(value) {
		if value[pos] == '\n' || value[pos] == '\r' {
			return pos
		}
		pos++
	}
	return len(value) - 1
}

func skipBlockCommentSQL(value string, pos int) int {
	end := strings.Index(value[pos+2:], "*/")
	if end < 0 {
		return len(value) - 1
	}
	return pos + end + 3
}

func (s *server) setSchema(schema string) error {
	db, err := s.requireDB()
	if err != nil {
		return err
	}
	_, err = db.Exec("ALTER SESSION SET CURRENT_SCHEMA = " + quoteIdentifier(schema))
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
	ctx, cancel := context.WithCancel(context.Background())
	var timer *time.Timer
	if timeoutSecs > 0 {
		var t *time.Timer
		t = time.AfterFunc(time.Duration(timeoutSecs)*time.Second, func() {
			s.activeCancelMu.Lock()
			if s.activeTimer == t {
				s.activeTimedOut = true
				cancel()
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

func stringSliceParam(params map[string]json.RawMessage, key string) []string {
	if params == nil || len(params[key]) == 0 {
		return nil
	}
	var value []string
	if err := json.Unmarshal(params[key], &value); err != nil {
		return nil
	}
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

func errorResponse(id json.RawMessage, err error) response {
	return response{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: -1, Message: err.Error()}}
}

func parseURLParams(raw string) map[string]string {
	result := map[string]string{}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return result
	}
	for key, items := range values {
		if len(items) > 0 {
			result[key] = items[len(items)-1]
		}
	}
	return result
}

func trimStatementSQL(sqlText string) string {
	trimmed := stripTrailingSlashDelimiter(strings.TrimSpace(sqlText))
	if isOraclePlSQLBlock(trimmed) {
		return trimmed
	}
	return strings.TrimRight(trimmed, "; \t\r\n")
}

func stripTrailingSlashDelimiter(sqlText string) string {
	trimmed := strings.TrimSpace(sqlText)
	if !strings.HasSuffix(trimmed, "/") {
		return trimmed
	}
	slashStart := len(trimmed) - 1
	lineStart := strings.LastIndex(trimmed[:slashStart], "\n") + 1
	if strings.TrimSpace(trimmed[lineStart:slashStart]) != "" {
		return trimmed
	}
	beforeSlash := strings.TrimSpace(trimmed[:lineStart])
	// SQL*Plus uses a standalone slash to execute PL/SQL blocks; go-ora needs
	// only the block text and not that client-side delimiter.
	if isOraclePlSQLBlock(beforeSlash) {
		return beforeSlash
	}
	return trimmed
}

func isOraclePlSQLBlock(sqlText string) bool {
	trimmed := strings.TrimSpace(sqlText)
	start := trimLeadingSQLComments(trimmed)
	if !oraclePlSQLBlockStartRegexp.MatchString(start) {
		return false
	}
	upper := strings.ToUpper(trimmed)
	if oraclePlSQLBlockEndRegexp.MatchString(upper) {
		return true
	}
	matches := oracleNamedPlSQLBlockEndRegexp.FindStringSubmatch(upper)
	if len(matches) != 2 {
		return false
	}
	switch matches[1] {
	case "IF", "LOOP", "CASE":
		return false
	default:
		return true
	}
}

func isQuerySQL(sqlText string) bool {
	executable := trimLeadingSQLComments(sqlText)
	return startsWithSQLKeyword(executable, "select") || startsWithSQLKeyword(executable, "with")
}

func trimLeadingSQLComments(sqlText string) string {
	remaining := strings.TrimSpace(sqlText)
	for {
		switch {
		case strings.HasPrefix(remaining, "--"):
			lineEnd := strings.IndexAny(remaining, "\r\n")
			if lineEnd < 0 {
				return ""
			}
			remaining = strings.TrimSpace(remaining[lineEnd+1:])
		case strings.HasPrefix(remaining, "/*"):
			commentEnd := strings.Index(remaining[2:], "*/")
			if commentEnd < 0 {
				return ""
			}
			remaining = strings.TrimSpace(remaining[commentEnd+4:])
		default:
			return remaining
		}
	}
}

func startsWithSQLKeyword(sqlText, keyword string) bool {
	sqlText = strings.TrimSpace(sqlText)
	if len(sqlText) < len(keyword) || !strings.EqualFold(sqlText[:len(keyword)], keyword) {
		return false
	}
	if len(sqlText) == len(keyword) {
		return true
	}
	next := sqlText[len(keyword)]
	return !((next >= 'a' && next <= 'z') || (next >= 'A' && next <= 'Z') || (next >= '0' && next <= '9') || next == '_' || next == '$')
}

func sqlKeywordAt(sqlText string, pos int, keyword string) bool {
	if pos < 0 || pos+len(keyword) > len(sqlText) || !strings.EqualFold(sqlText[pos:pos+len(keyword)], keyword) {
		return false
	}
	if pos > 0 && isOracleIdentifierPart(sqlText[pos-1]) {
		return false
	}
	if pos+len(keyword) >= len(sqlText) {
		return true
	}
	return !isOracleIdentifierPart(sqlText[pos+len(keyword)])
}

func quoteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func normalizeValue(value any, columnTypeName string) any {
	switch v := value.(type) {
	case nil:
		return nil
	case []byte:
		// Oracle RAW-like columns are binary data; decoding them as text produces mojibake.
		if isOracleBinaryColumnType(columnTypeName) {
			return bytesToHex(v)
		}
		return string(v)
	case time.Time:
		// Oracle DATE and plain TIMESTAMP are wall-clock values; adding an offset makes clients shift them.
		if isOracleTimezoneLessDateTime(columnTypeName) {
			return v.Format("2006-01-02T15:04:05.999999999")
		}
		return v.Format(time.RFC3339Nano)
	case int64, float64, bool, string:
		return v
	case fmt.Stringer:
		return v.String()
	default:
		return fmt.Sprint(v)
	}
}

func isOracleTimezoneLessDateTime(columnTypeName string) bool {
	normalized := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(columnTypeName), " ", ""))
	if normalized == "DATE" || normalized == "TIMESTAMPDTY" || normalized == "TIMESTAMP" {
		return true
	}
	return strings.HasPrefix(normalized, "TIMESTAMP(") && strings.HasSuffix(normalized, ")")
}

func isOracleBinaryColumnType(columnTypeName string) bool {
	normalized := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(columnTypeName), " ", ""))
	switch normalized {
	case "RAW", "VARRAW", "LONGRAW", "LONGVARRAW", "BLOB", "BFILE", "OCIBLOBLOCATOR", "OCIFILELOCATOR":
		return true
	default:
		return false
	}
}

func bytesToHex(bytes []byte) string {
	const digits = "0123456789abcdef"
	result := make([]byte, 2+len(bytes)*2)
	result[0] = '0'
	result[1] = 'x'
	for i, b := range bytes {
		result[2+i*2] = digits[b>>4]
		result[3+i*2] = digits[b&0x0f]
	}
	return string(result)
}

func emptyIfNil[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}

func intPtrFromString(value string) *int {
	if value == "" {
		return nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return nil
	}
	return &parsed
}
