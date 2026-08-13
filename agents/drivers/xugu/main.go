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
	"unicode"
	"unicode/utf8"

	_ "gitee.com/XuguDB/go-xugu-driver"
)

const protocolVersion = 1
const multiSessionProtocolVersion = 2
const defaultMaxRows = 1000
const defaultXuguPort = 5138
const legacyAgentSessionID = "__legacy__"
const maxAgentSessions = 256

// xuguPublicSynonymScope is a protocol-only namespace for database-global
// synonyms. It is deliberately not a real schema name (and must never be
// interpreted as one by metadata queries).
const xuguPublicSynonymScope = "\x00DBX_XUGU_PUBLIC_SYNONYMS"
const xuguListDatabasesSQL = `
SELECT DB_NAME
FROM ALL_DATABASES
ORDER BY DB_NAME`
const xuguListSchemasSQL = `
SELECT s.SCHEMA_NAME AS SCHEMA_NAME, FALSE AS IS_PUBLIC_SCOPE
FROM ALL_SCHEMAS s
WHERE s.DB_ID = CURRENT_DB_ID
UNION
SELECT '' AS SCHEMA_NAME, TRUE AS IS_PUBLIC_SCOPE
FROM ALL_SYNONYMS y
WHERE y.DB_ID = CURRENT_DB_ID
  AND y.IS_PUBLIC = TRUE
ORDER BY IS_PUBLIC_SCOPE, SCHEMA_NAME`
const xuguListSchemasFallbackSQL = `
SELECT SCHEMA_NAME
FROM ALL_SCHEMAS
WHERE DB_ID = CURRENT_DB_ID
ORDER BY SCHEMA_NAME`
const xuguCatalogTableNameSelectSQL = `
SELECT s.SCHEMA_NAME, t.TABLE_NAME
FROM ALL_TABLES t
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID`
const xuguCatalogSequenceNameSelectSQL = `
SELECT s.SCHEMA_NAME, q.SEQ_NAME
FROM ALL_SEQUENCES q
JOIN ALL_SCHEMAS s ON s.DB_ID = q.DB_ID AND s.SCHEMA_ID = q.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND q.IS_SYS = FALSE`
const xuguCatalogSynonymSelectSQL = `
SELECT s.SCHEMA_NAME,
       y.SYNO_NAME, t.SCHEMA_NAME AS TARGET_SCHEMA, y.TARG_NAME, y.IS_PUBLIC
FROM ALL_SYNONYMS y
LEFT JOIN ALL_SCHEMAS s ON s.DB_ID = y.DB_ID AND s.SCHEMA_ID = y.SCHEMA_ID
LEFT JOIN ALL_SCHEMAS t ON t.DB_ID = y.DB_ID AND t.SCHEMA_ID = y.TARG_SCHE_ID
WHERE y.DB_ID = CURRENT_DB_ID`
const xuguPrimaryKeyColumnsSQL = `
SELECT c.DEFINE
FROM ALL_CONSTRAINTS c
JOIN ALL_TABLES t ON t.DB_ID = c.DB_ID AND t.TABLE_ID = c.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ?
  AND t.TABLE_NAME = ?
  AND c.CONS_TYPE = 'P'`
const xuguListColumnsSQL = `
SELECT c.COL_NAME, c.TYPE_NAME, c.NOT_NULL, c.DEF_VAL, c.ON_NULL, c.COMMENTS, c.SCALE, c."VARYING"
FROM ALL_COLUMNS c
JOIN ALL_TABLES t ON t.DB_ID = c.DB_ID AND t.TABLE_ID = c.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ?
  AND t.TABLE_NAME = ?
  AND (c.IS_HIDE IS NULL OR c.IS_HIDE = FALSE)
ORDER BY c.COL_NO`
const xuguLegacyListColumnsSQL = `
SELECT c.COL_NAME, c.TYPE_NAME, c.NOT_NULL, c.DEF_VAL, c.COMMENTS, c.SCALE, c."VARYING"
FROM ALL_COLUMNS c
JOIN ALL_TABLES t ON t.DB_ID = c.DB_ID AND t.TABLE_ID = c.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ?
  AND t.TABLE_NAME = ?
  AND (c.IS_HIDE IS NULL OR c.IS_HIDE = FALSE)
ORDER BY c.COL_NO`
const xuguListIndexesSQL = `
SELECT i.INDEX_NAME, i.KEYS, i.IS_UNIQUE, i.IS_PRIMARY, i.INDEX_TYPE, i.FILTER
FROM ALL_INDEXES i
JOIN ALL_TABLES t ON t.DB_ID = i.DB_ID AND t.TABLE_ID = i.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ?
  AND t.TABLE_NAME = ?
ORDER BY i.INDEX_NAME`
const xuguTableMetadataSQL = `
SELECT t.TEMP_TYPE, t.ON_COMMIT_DEL, t.PCTFREE, t.COPY_NUM,
       t.PARTI_TYPE, t.PARTI_NUM, t.PARTI_KEY,
       t.AUTO_PARTI_TYPE, t.AUTO_PARTI_SPAN,
       t.SUBPARTI_TYPE, t.SUBPARTI_NUM, t.SUBPARTI_KEY, t.COMMENTS
FROM ALL_TABLES t
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ?
  AND t.TABLE_NAME = ?`
const xuguTableIdentitySQL = `
SELECT c.COL_NAME, q.MIN_VAL, q.STEP_VAL, q.IS_SYS
FROM ALL_COLUMNS c
JOIN ALL_TABLES t ON t.DB_ID = c.DB_ID AND t.TABLE_ID = c.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
JOIN ALL_SEQUENCES q ON q.DB_ID = c.DB_ID AND q.SEQ_ID = c.SERIAL_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ?
  AND t.TABLE_NAME = ?
  AND c.IS_SERIAL = TRUE`
const xuguTableConstraintsSQL = `
SELECT c.CONS_NAME, c.CONS_TYPE, c.DEFINE,
       rs.SCHEMA_NAME, rt.TABLE_NAME,
       c.MATCH_TYPE, c.UPDATE_ACTION, c.DELETE_ACTION,
       c.DEFERRABLE, c.INITDEFERRED, c.ENABLE, c.VALID, c.IS_SYS
FROM ALL_CONSTRAINTS c
JOIN ALL_TABLES t ON t.DB_ID = c.DB_ID AND t.TABLE_ID = c.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
LEFT JOIN ALL_TABLES rt ON rt.DB_ID = c.DB_ID AND rt.TABLE_ID = c.REF_TABLE_ID
LEFT JOIN ALL_SCHEMAS rs ON rs.DB_ID = rt.DB_ID AND rs.SCHEMA_ID = rt.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ?
  AND t.TABLE_NAME = ?
  AND c.CONS_TYPE <> 'F'
ORDER BY c.CONS_NAME`

// Keep foreign keys separate from the generic constraint query. The desktop
// presents them in their own group, while table DDL must replay them only after
// CREATE TABLE so that self-referencing tables can be restored safely.
const xuguTableForeignKeysSQL = `
SELECT c.CONS_NAME, c.CONS_TYPE, c.DEFINE,
       rs.SCHEMA_NAME, rt.TABLE_NAME,
       c.MATCH_TYPE, c.UPDATE_ACTION, c.DELETE_ACTION,
       c.DEFERRABLE, c.INITDEFERRED, c.ENABLE, c.VALID, c.IS_SYS
FROM ALL_CONSTRAINTS c
JOIN ALL_TABLES t ON t.DB_ID = c.DB_ID AND t.TABLE_ID = c.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
LEFT JOIN ALL_TABLES rt ON rt.DB_ID = c.DB_ID AND rt.TABLE_ID = c.REF_TABLE_ID
LEFT JOIN ALL_SCHEMAS rs ON rs.DB_ID = rt.DB_ID AND rs.SCHEMA_ID = rt.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ?
  AND t.TABLE_NAME = ?
  AND c.CONS_TYPE = 'F'
ORDER BY c.CONS_NAME`
const xuguTablePartitionsSQL = `
SELECT p.PARTI_NO, p.PARTI_NAME, p.PARTI_VAL, p.ONLINE,
       t.PARTI_TYPE, t.PARTI_KEY, t.AUTO_PARTI_TYPE, t.AUTO_PARTI_SPAN
FROM ALL_PARTIS p
JOIN ALL_TABLES t ON t.DB_ID = p.DB_ID AND t.TABLE_ID = p.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ?
  AND t.TABLE_NAME = ?
ORDER BY p.PARTI_NO`
const xuguTableSubpartitionsSQL = `
SELECT p.SUBPARTI_NO, p.SUBPARTI_NAME, p.SUBPARTI_VAL,
       t.SUBPARTI_TYPE, t.SUBPARTI_KEY
FROM ALL_SUBPARTIS p
JOIN ALL_TABLES t ON t.DB_ID = p.DB_ID AND t.TABLE_ID = p.TABLE_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ?
  AND t.TABLE_NAME = ?
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
	Name                      string       `json:"name"`
	ObjectType                string       `json:"object_type"`
	Schema                    string       `json:"schema"`
	Comment                   *string      `json:"comment"`
	Valid                     *bool        `json:"valid,omitempty"`
	Trigger                   *triggerInfo `json:"trigger,omitempty"`
	XuguTypeMembersExpandable *bool        `json:"xugu_type_members_expandable,omitempty"`
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
	keys            []xuguIndexKey
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
	Name      string  `json:"name"`
	Column    string  `json:"column"`
	RefSchema *string `json:"ref_schema,omitempty"`
	RefTable  string  `json:"ref_table"`
	RefColumn string  `json:"ref_column"`
	OnUpdate  *string `json:"on_update,omitempty"`
	OnDelete  *string `json:"on_delete,omitempty"`
}

// constraintInfo represents the user-visible ALL_CONSTRAINTS metadata that
// DBeaver's Xugu extension exposes below a table.
type constraintInfo struct {
	Name              string   `json:"name"`
	ConstraintType    string   `json:"constraint_type"`
	Definition        string   `json:"definition"`
	Columns           []string `json:"columns"`
	RefSchema         *string  `json:"ref_schema,omitempty"`
	RefTable          *string  `json:"ref_table,omitempty"`
	RefColumns        []string `json:"ref_columns"`
	MatchType         *string  `json:"match_type,omitempty"`
	OnUpdate          *string  `json:"on_update,omitempty"`
	OnDelete          *string  `json:"on_delete,omitempty"`
	Deferrable        bool     `json:"deferrable"`
	InitiallyDeferred bool     `json:"initially_deferred"`
	Enabled           bool     `json:"enabled"`
	Valid             bool     `json:"valid"`
}

type partitionInfo struct {
	Name              string  `json:"name"`
	Position          int     `json:"position"`
	Value             string  `json:"value"`
	PartitionType     string  `json:"partition_type"`
	PartitionKey      string  `json:"partition_key"`
	Online            *bool   `json:"online,omitempty"`
	AutoPartitionType *string `json:"auto_partition_type,omitempty"`
	AutoPartitionSpan *int    `json:"auto_partition_span,omitempty"`
}

type subpartitionInfo struct {
	Name          string `json:"name"`
	Position      int    `json:"position"`
	Value         string `json:"value"`
	PartitionType string `json:"partition_type"`
	PartitionKey  string `json:"partition_key"`
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
	Column          string
	Start           int64
	Step            int64
	SystemGenerated bool
}

// xuguSequenceMetadata contains the ALL_SEQUENCES fields needed to reproduce
// a user-managed sequence. IS_ORDER and VALID are runtime/catalog state and
// do not have CREATE SEQUENCE clauses, so they are intentionally omitted.
type xuguSequenceMetadata struct {
	Schema  string
	Name    string
	Current any
	Minimum any
	Maximum any
	Step    any
	Cache   any
	Cycle   any
	Comment any
}

type xuguCatalogSynonym struct {
	Schema       string
	Name         string
	TargetSchema sql.NullString
	TargetName   string
	Public       bool
}

// xuguIndexKey preserves the catalog spelling and SQL semantics of an index
// key. In particular, an index key can be a normal identifier, an identifier
// with ASC/DESC ordering, or an arbitrary expression such as LOWER("CODE").
// Only the first form can be compared to a table constraint column list.
type xuguIndexKey struct {
	Raw         string
	Column      string
	Direction   string
	PlainColumn bool
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
	Valid             bool
	SystemGenerated   bool
}

type xuguPartitionInfo struct {
	Name  string
	Value string
}

type triggerInfo struct {
	Name      string  `json:"name"`
	Event     string  `json:"event"`
	Timing    string  `json:"timing"`
	Level     string  `json:"level"`
	Condition *string `json:"condition,omitempty"`
	Language  *string `json:"language,omitempty"`
	Enabled   *bool   `json:"enabled,omitempty"`
	Valid     *bool   `json:"valid,omitempty"`
	Comment   *string `json:"comment,omitempty"`
	CreatedAt *string `json:"created_at,omitempty"`
}

type server struct {
	db           *sql.DB
	cancelDB     *sql.DB
	ownsCancelDB bool
	params       connectParams
	// currentDatabase tracks the last database this session successfully
	// connected to or USEd. Metadata calls must not skip USE solely because the
	// request matches the original connect-time database — the session may have
	// switched away (e.g. multi-database tree browse).
	currentDatabase   string
	nodeID            int
	databaseSessionID int64
	sessions          map[string]*querySession
	nextSessionID     int64
	activeCancelMu    sync.Mutex
	activeCancel      context.CancelFunc
	activeRows        map[*sql.Rows]context.CancelFunc
	activeTimer       *time.Timer
	activeTimedOut    bool
	activeCanceled    bool
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
			"protocolVersion":      multiSessionProtocolVersion,
			"agentProtocolVersion": multiSessionProtocolVersion,
			"capabilities":         []string{"connect", "test_connection", "metadata", "query", "ddl", "structured_error_v1", "multi_session"},
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
		err = r.reconnectSession(session)
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
		return fmt.Errorf("%w: %d", errAgentSessionLimit, maxAgentSessions)
	}
	r.mu.Unlock()

	server := newServer()
	// APP_NAME is useful for identifying a business session from SYS_SESSIONS,
	// but some Xugu server/driver combinations close the socket when an ordinary
	// user sends this optional login attribute. Keep the original parameters for
	// the permission-degraded path and add APP_NAME only when SYSTEM control is
	// actually available.
	businessParams := params
	if !xuguControlSessionEligible(params) {
		r.connectMu.Lock()
		_, err := server.connectWithControl(businessParams, nil, false)
		r.connectMu.Unlock()
		if err != nil {
			return err
		}
		return r.registerSession(agentSessionID, server, "")
	}
	identifiedParams := xuguIdentifiedSessionParams(params, agentSessionID)
	r.connectMu.Lock()
	controlKey, controlDB, controlErr := r.acquireControl(identifiedParams)
	var err error
	if controlErr == nil {
		var controlAttached bool
		controlAttached, err = server.connectWithControl(identifiedParams, controlDB, false)
		if err != nil || !controlAttached {
			// Business connect may have succeeded without cancel capability; drop the
			// unused shared control ref. On hard failure, also release the reservation.
			r.releaseControl(controlKey)
			controlKey = ""
			if err == nil || isXuguConnectionClosedError(err) {
				// The control account may be usable while the optional APP_NAME is
				// not accepted by the business login, or session tracking may be
				// unavailable. Retry once without the attribute and keep the session
				// usable without cancellation support.
				_, err = server.connectWithControl(businessParams, nil, false)
			}
		}
	} else {
		// SYSTEM control is optional for ordinary users (no SYSTEM account / no SYS_SESSIONS).
		// Fall back to a business-database-only session so metadata and queries still
		// work. Do not carry the optional APP_NAME into this degraded login path.
		_, err = server.connectWithControl(businessParams, nil, false)
		controlKey = ""
	}
	r.connectMu.Unlock()
	if err != nil {
		return err
	}
	return r.registerSession(agentSessionID, server, controlKey)
}

func (r *runtimeServer) registerSession(agentSessionID string, server *server, controlKey string) error {
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
		return fmt.Errorf("%w: %d", errAgentSessionLimit, maxAgentSessions)
	}
	r.sessions[agentSessionID] = session
	return nil
}

func (r *runtimeServer) reconnectSession(session *agentSession) error {
	return r.reconnectSessionWith(session, (*server).connectWithControl)
}

func (r *runtimeServer) reconnectSessionWith(
	session *agentSession,
	connect func(*server, connectParams, *sql.DB, bool) (bool, error),
) error {
	r.connectMu.Lock()
	controlAttached, err := connect(session.server, session.server.params, session.server.cancelDB, false)
	r.connectMu.Unlock()
	if !controlAttached {
		r.releaseControl(session.controlKey)
		session.controlKey = ""
	}
	return err
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
		return nil, fmt.Errorf("%w: %s", errAgentSessionNotFound, agentSessionID)
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
	return r.acquireControlWith(params, openDB)
}

func (r *runtimeServer) acquireControlWith(
	params connectParams,
	openControl func(connectParams) (*sql.DB, error),
) (string, *sql.DB, error) {
	r.controlMu.Lock()
	defer r.controlMu.Unlock()
	cancelParams := xuguControlParams(params)
	key := buildDSN(cancelParams)
	if control := r.controls[key]; control != nil {
		control.refs++
		return key, control.db, nil
	}
	db, err := openControl(cancelParams)
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
		return errorResponse(nil, "", "", err), false
	}
	if len(req.ID) == 0 {
		req.ID = json.RawMessage("1")
	}
	result, shutdown, err := s.dispatch(req.Method, req.Params)
	if err != nil {
		return errorResponse(req.ID, req.Method, stringParam(req.Params, "agentSessionId"), err), false
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
	case "completion_assistant_search_v1":
		var request completionAssistantRequest
		if err := decodeParams(params, &request); err != nil {
			return nil, false, err
		}
		if err := s.useDatabase(request.Database); err != nil {
			return nil, false, err
		}
		result, err := s.completionAssistantSearch(request)
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
	case "list_constraints":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		result, err := s.listConstraints(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "list_triggers":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		schema := stringParam(params, "schema")
		table := stringParam(params, "table")
		result, err := s.listTriggers(schema, table)
		return result, false, err
	case "list_partitions":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		result, err := s.listPartitions(stringParam(params, "schema"), stringParam(params, "table"))
		return result, false, err
	case "list_subpartitions":
		if err := s.useDatabase(stringParam(params, "database")); err != nil {
			return nil, false, err
		}
		result, err := s.listSubpartitions(stringParam(params, "schema"), stringParam(params, "table"))
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
	if !xuguControlSessionEligible(params) {
		_, err := s.connectWithControl(params, nil, false)
		return err
	}
	cancelParams := xuguControlParams(params)
	cancelDB, err := openDB(cancelParams)
	if err != nil {
		_, err = s.connectWithControl(params, nil, false)
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := cancelDB.PingContext(ctx); err != nil {
		cancelDB.Close()
		_, err = s.connectWithControl(params, nil, false)
		return err
	}
	attached, err := s.connectWithControl(params, cancelDB, true)
	if err != nil {
		// connectWithControl closes an owned cancelDB on failure.
		return err
	}
	if !attached {
		// Business session is usable; cancel/kill is degraded.
	}
	return nil
}

// connectWithControl opens the business database session.
// When cancelDB can query SYS_SESSIONS and a unique new session is identified,
// cancel/kill support is wired. Otherwise the session still succeeds without cancel
// (controlAttached=false). Ordinary users often cannot use SYSTEM control.
//
// controlAttached is true only when cancelDB remains owned by the server session.
// Callers that share cancelDB must release their control reservation when false.
func (s *server) connectWithControl(params connectParams, cancelDB *sql.DB, ownsCancelDB bool) (controlAttached bool, err error) {
	_ = s.disconnect()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	closeOwnedControl := func() {
		if ownsCancelDB && cancelDB != nil {
			_ = cancelDB.Close()
		}
	}

	var before map[xuguDatabaseSession]struct{}
	controlReady := false
	if cancelDB != nil {
		before, err = xuguDatabaseSessions(cancelDB)
		if err != nil {
			// e.g. E18012 on SYS_SESSIONS — keep business connect path.
			closeOwnedControl()
			cancelDB = nil
			ownsCancelDB = false
		} else {
			controlReady = true
		}
	}

	db, err := openDB(params)
	if err != nil {
		closeOwnedControl()
		return false, err
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		closeOwnedControl()
		return false, err
	}

	s.db = db
	s.params = params
	s.currentDatabase = configuredDatabaseName(params)
	s.cancelDB = nil
	s.ownsCancelDB = false
	s.nodeID = 0
	s.databaseSessionID = 0
	s.killSession = nil

	if !controlReady || cancelDB == nil {
		return false, nil
	}

	after, err := xuguDatabaseSessions(cancelDB)
	if err != nil {
		closeOwnedControl()
		return false, nil
	}
	databaseSession, err := newXuguDatabaseSession(before, after)
	if err != nil {
		// Ambiguous session tracking must not block ordinary browsing.
		closeOwnedControl()
		return false, nil
	}

	s.cancelDB = cancelDB
	s.ownsCancelDB = ownsCancelDB
	s.nodeID = databaseSession.nodeID
	s.databaseSessionID = databaseSession.sessionID
	s.killSession = func() {
		if s.cancelDB != nil && s.databaseSessionID > 0 {
			_, _ = s.cancelDB.Exec(fmt.Sprintf("CALL DBMS_DBA.KILL_SESSION_TRANS(%d, %d)", s.nodeID, s.databaseSessionID))
		}
	}
	return true, nil
}

func (s *server) disconnect() error {
	s.cancelActiveQuery()
	s.closeAllQuerySessions()
	if s.ownsCancelDB && s.cancelDB != nil {
		_ = s.cancelDB.Close()
	}
	s.currentDatabase = ""
	if s.db == nil {
		s.cancelDB = nil
		s.ownsCancelDB = false
		s.nodeID = 0
		s.databaseSessionID = 0
		s.killSession = nil
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

func xuguIdentifiedSessionParams(params connectParams, agentSessionID string) connectParams {
	params.URLParams = appendURLParam(params.URLParams, "APP_NAME", xuguSessionAppName(agentSessionID))
	return params
}

// Ordinary Xugu users often cannot use the SYSTEM control session, and some
// server builds close the socket when an optional APP_NAME is sent for them.
// Keep that path for explicit SYSDBA logins only; other users use a direct
// business session with the parameters they supplied.
func xuguControlSessionEligible(params connectParams) bool {
	return strings.EqualFold(strings.TrimSpace(params.Username), "SYSDBA")
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
	session, n, ok := controlSessionFromSnapshot(before, after)
	if !ok {
		return xuguDatabaseSession{}, fmt.Errorf("failed to identify Xugu server session: found %d new sessions", n)
	}
	return session, nil
}

// controlSessionFromSnapshot returns the single newly appeared session, if any.
// Callers treat ok=false as a soft degrade signal (no cancel/kill), not a hard error.
// n is the number of newly appeared sessions (useful for error messages).
func controlSessionFromSnapshot(
	before map[xuguDatabaseSession]struct{},
	after map[xuguDatabaseSession]struct{},
) (xuguDatabaseSession, int, bool) {
	var candidates []xuguDatabaseSession
	for session := range after {
		if _, existed := before[session]; !existed {
			candidates = append(candidates, session)
		}
	}
	if len(candidates) != 1 {
		return xuguDatabaseSession{}, len(candidates), false
	}
	return candidates[0], 1, true
}

func buildDSN(params connectParams) string {
	connectionString := strings.TrimSpace(params.ConnectionString)
	selectedDatabase := strings.TrimSpace(params.Database)
	if looksLikeXuguDSN(connectionString) {
		if selectedDatabase != "" {
			return overrideXuguDSNDatabase(connectionString, selectedDatabase)
		}
		return connectionString
	}
	if parsed := parseXuguURL(connectionString); parsed.Host != "" {
		if selectedDatabase != "" {
			parsed.Database = selectedDatabase
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
		if selectedDatabase != "" {
			jdbc.Database = selectedDatabase
		}
		return buildXuguDSN(jdbc.Host, jdbc.Port, jdbc.Database, params.Username, params.Password, params.URLParams)
	}

	return buildXuguDSN(params.Host, params.Port, params.Database, params.Username, params.Password, params.URLParams)
}

func looksLikeXuguDSN(value string) bool {
	upper := strings.ToUpper(value)
	return strings.Contains(upper, "IP=") && strings.Contains(upper, "DB=") && strings.Contains(upper, "USER=")
}

func overrideXuguDSNDatabase(dsn, database string) string {
	var result strings.Builder
	result.Grow(len(dsn) + len(database))

	segmentStart := 0
	inQuotes := false
	for index := 0; index < len(dsn); index++ {
		switch dsn[index] {
		case '\'':
			if inQuotes && index+1 < len(dsn) && dsn[index+1] == '\'' {
				index++
				continue
			}
			inQuotes = !inQuotes
		case ';':
			if !inQuotes {
				result.WriteString(overrideXuguDSNSegmentDatabase(dsn[segmentStart:index], database))
				result.WriteByte(';')
				segmentStart = index + 1
			}
		}
	}
	result.WriteString(overrideXuguDSNSegmentDatabase(dsn[segmentStart:], database))
	return result.String()
}

func overrideXuguDSNSegmentDatabase(segment, database string) string {
	separator := strings.IndexByte(segment, '=')
	if separator < 0 || !strings.EqualFold(strings.TrimSpace(segment[:separator]), "DB") {
		return segment
	}

	// Xugu DSN values may quote semicolons and escape quotes by doubling them.
	return segment[:separator+1] + encodeXuguDSNValue(database)
}

func encodeXuguDSNValue(value string) string {
	if !strings.ContainsAny(value, ";'") {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
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
	// Skip only when the live session is already on this database.
	if s.currentDatabase != "" && strings.EqualFold(database, s.currentDatabase) {
		return nil
	}
	// Fresh session still on connect-time DB: avoid a redundant USE.
	if s.currentDatabase == "" {
		if configured := configuredDatabaseName(s.params); configured != "" && strings.EqualFold(database, configured) {
			s.currentDatabase = configured
			return nil
		}
	}
	if err := s.execWithReconnect("USE " + quoteIdentifier(database)); err != nil {
		return err
	}
	s.currentDatabase = database
	return nil
}

func (s *server) listDatabases() ([]databaseInfo, error) {
	rows, err := s.queryRows(xuguListDatabasesSQL, nil)
	if err != nil {
		if fallback := fallbackDatabasesFromParams(s.params); len(fallback) > 0 && isXuguMetadataUnavailableError(err) {
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
	if err == nil {
		return false
	}
	message := strings.ToUpper(strings.TrimSpace(strings.TrimRight(err.Error(), "\x00")))
	for _, marker := range []string{
		"E18012", "权限不够", "PERMISSION DENIED", "ACCESS DENIED", "INSUFFICIENT PRIVILEGE", "NOT AUTHORIZED",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	catalogObject := false
	for _, object := range []string{
		"DATABASES", "SCHEMAS", "TABLES", "VIEWS", "COLUMNS", "CONSTRAINTS", "INDEXES",
		"TRIGGERS", "PARTIS", "SUBPARTIS", "SEQUENCES", "SYNONYMS", "PROCEDURES", "PACKAGES", "TYPES",
	} {
		if strings.Contains(message, "ALL_"+object) || strings.Contains(message, "SYS_"+object) {
			catalogObject = true
			break
		}
	}
	if !catalogObject {
		return false
	}
	for _, marker := range []string{
		"不存在", "DOES NOT EXIST", "NOT EXIST", "UNKNOWN TABLE", "UNKNOWN VIEW", "UNDEFINED TABLE", "INVALID OBJECT NAME",
	} {
		if strings.Contains(message, marker) {
			return true
		}
	}
	return false
}

// Xugu closes the business connection for some metadata statements when the
// connected user is not allowed to read the corresponding ALL_* view. The Go
// driver surfaces that server-side close as EOF instead of E18012. Treat this
// separately from ordinary network errors so a metadata request can be retried
// on a fresh business session without hiding unrelated failures.
func isXuguConnectionClosedError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) {
		return true
	}
	message := strings.ToUpper(strings.TrimSpace(err.Error()))
	return strings.Contains(message, "EOF") &&
		(strings.Contains(message, "连接") || strings.Contains(message, "CONNECTION") || strings.Contains(message, "RECEIVE"))
}

func isXuguMetadataUnavailableError(err error) bool {
	return isXuguMetadataAccessError(err) || isXuguConnectionClosedError(err)
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
		rows, err = s.queryRows(xuguListSchemasFallbackSQL, nil)
		if err != nil {
			if fallback := strings.ToUpper(strings.TrimSpace(s.params.Username)); fallback != "" && isXuguMetadataUnavailableError(err) {
				return []string{fallback}, nil
			}
			return nil, err
		}
		return s.scanXuguSchemaRows(rows, false)
	}
	return s.scanXuguSchemaRows(rows, true)
}

func (s *server) scanXuguSchemaRows(rows *sql.Rows, includesPublicScope bool) ([]string, error) {
	defer s.closeRows(rows)
	var result []string
	for rows.Next() {
		var schema sql.NullString
		var publicScope bool
		var err error
		if includesPublicScope {
			err = rows.Scan(&schema, &publicScope)
		} else {
			err = rows.Scan(&schema)
		}
		if err != nil {
			return nil, err
		}
		if publicScope {
			result = append(result, xuguPublicSynonymScope)
		} else if schema.Valid && schema.String != "" {
			result = append(result, schema.String)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return dedupeXuguSchemaNames(result), nil
}

func dedupeXuguSchemaNames(names []string) []string {
	seen := make(map[string]struct{}, len(names))
	result := make([]string, 0, len(names))
	for _, name := range names {
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	return emptyIfNil(result)
}

func isXuguPublicSynonymScope(schema string) bool {
	return strings.TrimSpace(schema) == xuguPublicSynonymScope
}

func (s *server) currentSchema() (string, error) {
	rows, err := s.queryRows(`
SELECT s.SCHEMA_NAME
FROM SYS_SCHEMAS s
JOIN SYS_USERS u ON u.DB_ID = s.DB_ID AND u.USER_ID = s.USER_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(u.USER_NAME) = UPPER(?)
ORDER BY CASE WHEN UPPER(s.SCHEMA_NAME) = UPPER(?) THEN 0 ELSE 1 END, s.SCHEMA_NAME`, []any{s.params.Username, s.params.Username})
	if err != nil {
		if fallback := strings.ToUpper(strings.TrimSpace(s.params.Username)); fallback != "" && isXuguMetadataUnavailableError(err) {
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
		if isXuguMetadataUnavailableError(err) {
			fallback, fallbackErr := s.listOwnTables(schema, constraints)
			if fallbackErr == nil && len(fallback) > 0 {
				return fallback, nil
			}
			if fallbackErr != nil && !isXuguMetadataUnavailableError(fallbackErr) {
				return nil, fallbackErr
			}
			available, availableErr := s.listTablesByAvailableSources(schema, constraints)
			if availableErr == nil {
				return available, nil
			}
			if fallbackErr != nil && isXuguMetadataUnavailableError(fallbackErr) {
				return []tableInfo{}, nil
			}
			return nil, availableErr
		}
		return nil, err
	}
	defer s.closeRows(rows)
	return readXuguTableRows(rows)
}

func (s *server) listOwnTables(schema string, constraints metadataListConstraints) ([]tableInfo, error) {
	if !strings.EqualFold(strings.TrimSpace(schema), strings.TrimSpace(s.params.Username)) {
		return []tableInfo{}, nil
	}
	query := xuguConstrainedMetadataListQuery(
		`
SELECT TABLE_NAME, 'TABLE' AS TABLE_TYPE, COMMENTS
FROM USER_TABLES
UNION ALL
SELECT VIEW_NAME, 'VIEW' AS TABLE_TYPE, COMMENTS
FROM USER_VIEWS`,
		"TABLE_NAME, TABLE_TYPE, COMMENTS",
		"TABLE_NAME",
		"TABLE_TYPE",
		nil,
		constraints,
	)
	rows, err := s.queryRows(query.SQL, query.Args)
	if err != nil {
		if isXuguMetadataUnavailableError(err) {
			return []tableInfo{}, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)
	return readXuguTableRows(rows)
}

func readXuguTableRows(rows *sql.Rows) ([]tableInfo, error) {
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

// listTablesByAvailableSources keeps table metadata visible when a combined
// TABLE/VIEW catalog query is rejected or closes an ordinary user's session.
// Each source is queried independently, so a restricted view catalog cannot
// hide otherwise readable tables (and vice versa).
func (s *server) listTablesByAvailableSources(schema string, constraints metadataListConstraints) ([]tableInfo, error) {
	requested := normalizedXuguObjectTypes(constraints.ObjectTypes)
	wanted := map[string]bool{"TABLE": true, "VIEW": true}
	if len(requested) > 0 {
		wanted = make(map[string]bool, len(requested))
		for _, objectType := range requested {
			if objectType == "TABLE" || objectType == "VIEW" {
				wanted[objectType] = true
			}
		}
	}
	result := make([]tableInfo, 0)
	for _, objectType := range []string{"TABLE", "VIEW"} {
		if !wanted[objectType] {
			continue
		}
		scoped := constraints
		scoped.ObjectTypes = []string{objectType}
		scoped.Limit = 0
		scoped.Offset = 0
		query := xuguListTablesQuery(schema, scoped)
		rows, err := s.queryRows(query.SQL, query.Args)
		if err != nil {
			if isXuguMetadataUnavailableError(err) {
				continue
			}
			return nil, err
		}
		items, err := readXuguTableRows(rows)
		s.closeRows(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, items...)
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].TableType != result[j].TableType {
			return result[i].TableType < result[j].TableType
		}
		return result[i].Name < result[j].Name
	})
	if constraints.Offset > 0 {
		if constraints.Offset >= len(result) {
			return []tableInfo{}, nil
		}
		result = result[constraints.Offset:]
	}
	if constraints.Limit > 0 && len(result) > constraints.Limit {
		result = result[:constraints.Limit]
	}
	return emptyIfNil(result), nil
}

func (s *server) listObjects(schema string, constraints metadataListConstraints) ([]objectInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	if isOnlyXuguObjectType(constraints, "TRIGGER") {
		return s.listSchemaTriggers(schema, constraints)
	}
	query := xuguListObjectsQuery(schema, constraints)
	rows, err := s.queryRows(query.SQL, query.Args)
	if err != nil {
		if isXuguMetadataUnavailableError(err) {
			// Preserve the low-privilege USER_TABLES/USER_VIEWS path when the
			// combined object catalog is denied. Programmable object catalogs are
			// then queried independently so one denied ALL_* view does not hide
			// the remaining accessible groups.
			fallbackConstraints := constraints
			fallbackConstraints.Limit = 0
			fallbackConstraints.Offset = 0
			result := make([]objectInfo, 0)
			seen := make(map[string]bool)
			appendObject := func(item objectInfo) {
				key := item.Schema + "\x00" + item.ObjectType + "\x00" + item.Name
				if !seen[key] {
					seen[key] = true
					result = append(result, item)
				}
			}
			requested := availableXuguObjectTypes(constraints.ObjectTypes)
			wantTableFallback := len(constraints.ObjectTypes) == 0
			for _, objectType := range requested {
				if objectType == "TABLE" || objectType == "VIEW" {
					wantTableFallback = true
					break
				}
			}
			if wantTableFallback {
				tables, tableErr := s.listTables(schema, fallbackConstraints)
				if tableErr != nil && !isXuguMetadataUnavailableError(tableErr) {
					return nil, tableErr
				}
				for _, table := range tables {
					appendObject(objectInfo{Name: table.Name, ObjectType: table.TableType, Schema: schema, Comment: table.Comment})
				}
			}
			available, availableErr := s.listObjectsByAvailableSources(schema, fallbackConstraints)
			if availableErr != nil {
				return nil, availableErr
			}
			for _, item := range available {
				appendObject(item)
			}
			sort.SliceStable(result, func(i, j int) bool {
				if result[i].ObjectType != result[j].ObjectType {
					return result[i].ObjectType < result[j].ObjectType
				}
				return result[i].Name < result[j].Name
			})
			if constraints.Offset > 0 {
				if constraints.Offset >= len(result) {
					return []objectInfo{}, nil
				}
				result = result[constraints.Offset:]
			}
			if constraints.Limit > 0 && len(result) > constraints.Limit {
				result = result[:constraints.Limit]
			}
			if len(result) == 0 {
				return []objectInfo{}, nil
			}
			return result, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)
	return readXuguObjectRows(rows, schema)
}

func isOnlyXuguObjectType(constraints metadataListConstraints, objectType string) bool {
	objectTypes := normalizedXuguObjectTypes(constraints.ObjectTypes)
	return len(objectTypes) == 1 && objectTypes[0] == objectType
}

func (s *server) listSchemaTriggers(schema string, constraints metadataListConstraints) ([]objectInfo, error) {
	query := xuguSchemaTriggersQuery(schema, constraints)
	rows, err := s.queryRows(query.SQL, query.Args)
	if err != nil {
		if isXuguMetadataUnavailableError(err) {
			return []objectInfo{}, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)

	var result []objectInfo
	for rows.Next() {
		var item objectInfo
		var event, timing, level, condition, language, enabled, valid, comment, createdAt any
		if err := rows.Scan(&item.Name, &item.ObjectType, &comment, &valid, &event, &timing, &level, &condition, &language, &enabled, &createdAt); err != nil {
			return nil, err
		}
		item.Schema = schema
		item.Comment = optionalString(xuguString(comment))
		item.Valid = optionalBool(valid)
		item.Trigger = &triggerInfo{
			Name:      item.Name,
			Event:     triggerEventName(event),
			Timing:    triggerTimingName(timing),
			Level:     triggerLevelName(level),
			Condition: optionalString(xuguString(condition)),
			Language:  optionalString(xuguString(language)),
			Enabled:   optionalBool(enabled),
			Valid:     item.Valid,
			Comment:   item.Comment,
			CreatedAt: optionalString(xuguString(createdAt)),
		}
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func xuguSchemaTriggersQuery(schema string, constraints metadataListConstraints) xuguMetadataListQuery {
	return xuguConstrainedMetadataListQuery(`
SELECT tr.TRIG_NAME AS OBJECT_NAME, 'TRIGGER' AS OBJECT_TYPE, tr.COMMENTS, tr.VALID,
       tr.TRIG_EVENT, tr.TRIG_TIME, tr.TRIG_TYPE, tr.TRIG_COND, tr.LANGUAGE, tr.ENABLE, tr.CREATE_TIME
FROM ALL_TRIGGERS tr
JOIN ALL_SCHEMAS s ON s.DB_ID = tr.DB_ID AND s.SCHEMA_ID = tr.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)`,
		"OBJECT_NAME, OBJECT_TYPE, COMMENTS, VALID, TRIG_EVENT, TRIG_TIME, TRIG_TYPE, TRIG_COND, LANGUAGE, ENABLE, CREATE_TIME",
		"OBJECT_NAME", "OBJECT_TYPE", []any{schema}, constraints)
}

func readXuguObjectRows(rows *sql.Rows, schema string) ([]objectInfo, error) {
	var result []objectInfo
	for rows.Next() {
		var item objectInfo
		var valid, xuguTypeMembersExpandable any
		item.Schema = schema
		if err := rows.Scan(&item.Name, &item.ObjectType, &item.Comment, &valid, &xuguTypeMembersExpandable); err != nil {
			return nil, err
		}
		if valid != nil {
			value := truthy(valid)
			item.Valid = &value
		}
		if normalizeValue(xuguTypeMembersExpandable) != nil {
			value := truthy(xuguTypeMembersExpandable)
			item.XuguTypeMembersExpandable = &value
		}
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

// listObjectsByAvailableSources is used only after the combined catalog query
// fails. Xugu may close a normal user's session when one ALL_* view is denied;
// querying each object family independently lets accessible groups remain
// visible instead of turning the entire schema tree into a connection error.
func (s *server) listObjectsByAvailableSources(schema string, constraints metadataListConstraints) ([]objectInfo, error) {
	objectTypes := availableXuguObjectTypes(constraints.ObjectTypes)
	result := make([]objectInfo, 0)
	for _, objectType := range objectTypes {
		scoped := constraints
		scoped.ObjectTypes = []string{objectType}
		scoped.Limit = 0
		scoped.Offset = 0
		query := xuguListObjectsQuery(schema, scoped)
		rows, err := s.queryRows(query.SQL, query.Args)
		if err != nil {
			if isXuguMetadataUnavailableError(err) {
				continue
			}
			return nil, err
		}
		items, err := readXuguObjectRows(rows, schema)
		s.closeRows(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, items...)
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].ObjectType != result[j].ObjectType {
			return result[i].ObjectType < result[j].ObjectType
		}
		return result[i].Name < result[j].Name
	})
	if constraints.Offset > 0 {
		if constraints.Offset >= len(result) {
			return []objectInfo{}, nil
		}
		result = result[constraints.Offset:]
	}
	if constraints.Limit > 0 && len(result) > constraints.Limit {
		result = result[:constraints.Limit]
	}
	return emptyIfNil(result), nil
}

func availableXuguObjectTypes(requested []string) []string {
	available := []string{"TABLE", "VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY", "TRIGGER", "SEQUENCE", "SYNONYM", "TYPE", "TYPE_BODY"}
	if len(requested) == 0 {
		return available
	}
	selected := normalizedXuguObjectTypes(requested)
	selectedSet := make(map[string]bool, len(selected))
	for _, objectType := range selected {
		selectedSet[objectType] = true
	}
	result := make([]string, 0, len(selected))
	for _, objectType := range available {
		if selectedSet[objectType] {
			result = append(result, objectType)
		}
	}
	return result
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
	type tableSource struct {
		objectType string
		sql        string
	}
	sources := []tableSource{
		{objectType: "TABLE", sql: `
SELECT t.TABLE_NAME, 'TABLE' AS TABLE_TYPE, t.COMMENTS
FROM ALL_TABLES t
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)`},
		{objectType: "VIEW", sql: `
SELECT v.VIEW_NAME AS TABLE_NAME, 'VIEW' AS TABLE_TYPE, v.COMMENTS
FROM ALL_VIEWS v
JOIN ALL_SCHEMAS s ON s.DB_ID = v.DB_ID AND s.SCHEMA_ID = v.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)`},
	}
	selected := normalizedXuguObjectTypes(constraints.ObjectTypes)
	selectedSet := make(map[string]bool, len(selected))
	for _, objectType := range selected {
		selectedSet[objectType] = true
	}
	baseSources := sources
	if len(selected) > 0 {
		baseSources = make([]tableSource, 0, len(selected))
		for _, source := range sources {
			if selectedSet[source.objectType] {
				baseSources = append(baseSources, source)
			}
		}
	}
	baseSQLParts := make([]string, 0, len(baseSources))
	baseArgs := make([]any, 0, len(baseSources))
	for _, source := range baseSources {
		baseSQLParts = append(baseSQLParts, source.sql)
		baseArgs = append(baseArgs, schema)
	}
	return xuguConstrainedMetadataListQuery(
		strings.Join(baseSQLParts, "\nUNION ALL\n"),
		"TABLE_NAME, TABLE_TYPE, COMMENTS",
		"TABLE_NAME",
		"TABLE_TYPE",
		baseArgs,
		constraints,
	)
}

func xuguListObjectsQuery(schema string, constraints metadataListConstraints) xuguMetadataListQuery {
	// Public synonyms have no owning schema in Xugu. They are queried only
	// through the reserved protocol scope; a real schema named GUEST remains
	// a normal private-synonym namespace.
	publicSynonymScope := isXuguPublicSynonymScope(schema)
	synonymSQL := `
SELECT y.SYNO_NAME AS OBJECT_NAME, 'SYNONYM' AS OBJECT_TYPE, NULL AS COMMENTS, y.VALID, NULL AS XUGU_TYPE_MEMBERS_EXPANDABLE
FROM ALL_SYNONYMS y
WHERE y.DB_ID = CURRENT_DB_ID
  AND y.IS_PUBLIC = TRUE`
	if !publicSynonymScope {
		synonymSQL = `
SELECT y.SYNO_NAME AS OBJECT_NAME, 'SYNONYM' AS OBJECT_TYPE, NULL AS COMMENTS, y.VALID, NULL AS XUGU_TYPE_MEMBERS_EXPANDABLE
FROM ALL_SYNONYMS y
JOIN ALL_SCHEMAS s ON s.DB_ID = y.DB_ID AND s.SCHEMA_ID = y.SCHEMA_ID
WHERE y.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND y.IS_PUBLIC = FALSE`
	}
	type objectSource struct {
		objectTypes []string
		sql         string
	}
	sources := []objectSource{
		{objectTypes: []string{"TABLE"}, sql: `
SELECT t.TABLE_NAME AS OBJECT_NAME, 'TABLE' AS OBJECT_TYPE, t.COMMENTS, NULL AS VALID, NULL AS XUGU_TYPE_MEMBERS_EXPANDABLE
FROM ALL_TABLES t
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)`},
		{objectTypes: []string{"VIEW"}, sql: `
SELECT v.VIEW_NAME AS OBJECT_NAME, 'VIEW' AS OBJECT_TYPE, v.COMMENTS, v.VALID, NULL AS XUGU_TYPE_MEMBERS_EXPANDABLE
FROM ALL_VIEWS v
JOIN ALL_SCHEMAS s ON s.DB_ID = v.DB_ID AND s.SCHEMA_ID = v.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)`},
		{objectTypes: []string{"PROCEDURE", "FUNCTION"}, sql: `
		SELECT p.PROC_NAME AS OBJECT_NAME,
		       CASE WHEN p.RET_TYPE IS NULL THEN 'PROCEDURE' ELSE 'FUNCTION' END AS OBJECT_TYPE,
		       p.COMMENTS, p.VALID, NULL AS XUGU_TYPE_MEMBERS_EXPANDABLE
		FROM ALL_PROCEDURES p
		JOIN ALL_SCHEMAS s ON s.DB_ID = p.DB_ID AND s.SCHEMA_ID = p.SCHEMA_ID
		WHERE s.DB_ID = CURRENT_DB_ID
		  AND UPPER(s.SCHEMA_NAME) = UPPER(?)`},
		{objectTypes: []string{"PACKAGE"}, sql: `
SELECT p.PACK_NAME AS OBJECT_NAME, 'PACKAGE' AS OBJECT_TYPE, p.COMMENTS, p.VALID, NULL AS XUGU_TYPE_MEMBERS_EXPANDABLE
FROM ALL_PACKAGES p
JOIN ALL_SCHEMAS s ON s.DB_ID = p.DB_ID AND s.SCHEMA_ID = p.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)`},
		{objectTypes: []string{"PACKAGE_BODY"}, sql: `
SELECT p.PACK_NAME AS OBJECT_NAME, 'PACKAGE_BODY' AS OBJECT_TYPE, p.COMMENTS, p.ALL_OK, NULL AS XUGU_TYPE_MEMBERS_EXPANDABLE
FROM ALL_PACKAGES p
JOIN ALL_SCHEMAS s ON s.DB_ID = p.DB_ID AND s.SCHEMA_ID = p.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND p.BODY IS NOT NULL`},
		{objectTypes: []string{"TRIGGER"}, sql: `
SELECT tr.TRIG_NAME AS OBJECT_NAME, 'TRIGGER' AS OBJECT_TYPE, tr.COMMENTS, tr.VALID, NULL AS XUGU_TYPE_MEMBERS_EXPANDABLE
FROM ALL_TRIGGERS tr
JOIN ALL_SCHEMAS s ON s.DB_ID = tr.DB_ID AND s.SCHEMA_ID = tr.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)`},
		{objectTypes: []string{"SEQUENCE"}, sql: `
		SELECT q.SEQ_NAME AS OBJECT_NAME, 'SEQUENCE' AS OBJECT_TYPE, NULL AS COMMENTS, NULL AS VALID, NULL AS XUGU_TYPE_MEMBERS_EXPANDABLE
FROM ALL_SEQUENCES q
JOIN ALL_SCHEMAS s ON s.DB_ID = q.DB_ID AND s.SCHEMA_ID = q.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND q.IS_SYS = FALSE`},
		{objectTypes: []string{"SYNONYM"}, sql: synonymSQL},
		{objectTypes: []string{"TYPE"}, sql: `
SELECT u.TYPE_NAME AS OBJECT_NAME, 'TYPE' AS OBJECT_TYPE, u.COMMENTS, u.VALID,
	       CASE WHEN u.UDT_TYPE = 1001 THEN TRUE ELSE FALSE END AS XUGU_TYPE_MEMBERS_EXPANDABLE
FROM ALL_TYPES u
JOIN ALL_SCHEMAS s ON s.DB_ID = u.DB_ID AND s.SCHEMA_ID = u.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)`},
		{objectTypes: []string{"TYPE_BODY"}, sql: `
SELECT u.TYPE_NAME AS OBJECT_NAME, 'TYPE_BODY' AS OBJECT_TYPE, u.COMMENTS, u.VALID, NULL AS XUGU_TYPE_MEMBERS_EXPANDABLE
FROM ALL_TYPES u
JOIN ALL_SCHEMAS s ON s.DB_ID = u.DB_ID AND s.SCHEMA_ID = u.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND u.BODY IS NOT NULL`},
	}

	selected := normalizedXuguObjectTypes(constraints.ObjectTypes)
	selectedSet := make(map[string]bool, len(selected))
	for _, objectType := range selected {
		selectedSet[objectType] = true
	}
	// Keep the complete query for an unconstrained listing. For an explicit
	// object group, include only the requested catalog view; this prevents a
	// denied ALL_* view from breaking unrelated groups for ordinary users.
	filterUnsupported := len(constraints.ObjectTypes) > 0 && len(selected) == 0
	baseSources := sources
	if len(selected) > 0 && !filterUnsupported {
		baseSources = make([]objectSource, 0, len(selected))
		for _, source := range sources {
			include := false
			for _, objectType := range source.objectTypes {
				if selectedSet[objectType] {
					include = true
					break
				}
			}
			if include {
				baseSources = append(baseSources, source)
			}
		}
	}
	baseSQLParts := make([]string, 0, len(baseSources))
	baseArgs := make([]any, 0, len(baseSources))
	for _, source := range baseSources {
		baseSQLParts = append(baseSQLParts, source.sql)
		if !(publicSynonymScope && len(source.objectTypes) == 1 && source.objectTypes[0] == "SYNONYM") {
			baseArgs = append(baseArgs, schema)
		}
	}
	return xuguConstrainedMetadataListQuery(
		strings.Join(baseSQLParts, "\nUNION ALL\n"),
		"OBJECT_NAME, OBJECT_TYPE, COMMENTS, VALID, XUGU_TYPE_MEMBERS_EXPANDABLE",
		"OBJECT_NAME",
		"OBJECT_TYPE",
		baseArgs,
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
		case "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "SYNONYM", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY":
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
	catalogSchema, catalogTable, err := s.resolveCatalogTableName(schema, table)
	if err != nil {
		if isXuguMetadataUnavailableError(err) || isXuguTableNotFoundError(err) {
			fallbackSchema, fallbackTable, fallbackErr := s.fallbackTableIdentity(schema, table)
			if fallbackErr != nil {
				return nil, fallbackErr
			}
			columns, directErr := s.columnsFromSelect(fallbackSchema, fallbackTable, map[string]bool{})
			if directErr == nil {
				return columns, nil
			}
			if isXuguMetadataUnavailableError(err) && isXuguMetadataUnavailableError(directErr) {
				return []columnInfo{}, nil
			}
			if isXuguTableNotFoundError(directErr) {
				return nil, err
			}
			return nil, directErr
		}
		return nil, err
	}
	schema, table = catalogSchema, catalogTable
	primaryKeys, err := s.primaryKeyColumns(schema, table)
	if err != nil {
		return nil, err
	}
	rows, hasDefaultOnNull, err := s.queryColumnRows(schema, table)
	if err != nil {
		if isXuguMetadataUnavailableError(err) {
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
		item.IsPrimaryKey = primaryKeys[item.Name]
		item.NumericPrecision, item.NumericScale, item.CharacterMaximumLength = decodeXuguScale(item.DataType, scale)
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) queryColumnRows(schema, table string) (*sql.Rows, bool, error) {
	rows, err := s.queryRows(xuguTableCatalogQuery(xuguListColumnsSQL, schema, table), nil)
	if err == nil {
		return rows, true, nil
	}
	if !isXuguMissingOnNullColumnError(err) {
		return nil, false, err
	}
	rows, err = s.queryRows(xuguTableCatalogQuery(xuguLegacyListColumnsSQL, schema, table), nil)
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
			IsPrimaryKey: primaryKeys[columnType.Name()],
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

func (s *server) fallbackTableIdentity(schema, table string) (string, string, error) {
	schema = strings.TrimSpace(schema)
	if schema == "" {
		var err error
		schema, err = s.currentSchema()
		if err != nil {
			return "", "", err
		}
	}
	table = strings.TrimSpace(table)
	if table == "" {
		return "", "", errors.New("table is required")
	}
	return schema, table, nil
}

func isXuguTableNotFoundError(err error) bool {
	return strings.Contains(strings.ToUpper(err.Error()), "TABLE NOT FOUND:")
}

func (s *server) primaryKeyColumns(schema, table string) (map[string]bool, error) {
	rows, err := s.queryRows(xuguTableCatalogQuery(xuguPrimaryKeyColumnsSQL, schema, table), nil)
	if err != nil {
		if isXuguMetadataUnavailableError(err) {
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
			result[column] = true
		}
	}
	return result, rows.Err()
}

func (s *server) listIndexes(schema, table string) ([]indexInfo, error) {
	catalogSchema, catalogTable, err := s.resolveCatalogTableName(schema, table)
	if err != nil {
		// Resolving the catalog name itself may touch ALL_TABLES and can
		// terminate an ordinary user's session before the index query runs.
		// Treat that the same way as an inaccessible index catalog so the
		// table tree remains usable instead of returning a cascading RPC EOF.
		if isXuguMetadataUnavailableError(err) || isXuguTableNotFoundError(err) {
			return []indexInfo{}, nil
		}
		return nil, err
	}
	rows, err := s.queryRows(xuguTableCatalogQuery(xuguListIndexesSQL, catalogSchema, catalogTable), nil)
	if err != nil {
		if isXuguMetadataUnavailableError(err) {
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
		item.keys = parseXuguIndexKeys(keys)
		item.Columns = indexKeyDisplayNames(item.keys)
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
	constraints, err := s.tableForeignKeys(schema, table)
	if err != nil {
		if isXuguMetadataUnavailableError(err) {
			return []foreignKeyInfo{}, nil
		}
		return nil, err
	}
	var result []foreignKeyInfo
	for _, constraint := range constraints {
		local, ref := parseForeignKeyColumns(constraint.Definition)
		for i, column := range local {
			item := foreignKeyInfo{
				Name: constraint.Name, Column: column, RefTable: constraint.ReferenceTable,
				RefSchema: optionalString(constraint.ReferenceSchema),
				OnUpdate:  optionalString(xuguReferentialAction(constraint.UpdateAction)),
				OnDelete:  optionalString(xuguReferentialAction(constraint.DeleteAction)),
			}
			if i < len(ref) {
				item.RefColumn = ref[i]
			}
			result = append(result, item)
		}
	}
	return emptyIfNil(result), nil
}

func (s *server) listTriggers(schema, table string) ([]triggerInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	table = strings.ToUpper(strings.TrimSpace(table))
	rows, err := s.queryRows(`
SELECT tr.TRIG_NAME, tr.TRIG_EVENT, tr.TRIG_TIME, tr.TRIG_TYPE,
       tr.TRIG_COND, tr.LANGUAGE, tr.ENABLE, tr.VALID, tr.COMMENTS, tr.CREATE_TIME
FROM ALL_TRIGGERS tr
JOIN ALL_TABLES t ON t.DB_ID = tr.DB_ID AND t.TABLE_ID = tr.OBJ_ID
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)
  AND UPPER(t.TABLE_NAME) = UPPER(?)
ORDER BY tr.TRIG_NAME`, []any{schema, table})
	if err != nil {
		if isXuguMetadataUnavailableError(err) {
			return []triggerInfo{}, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)
	var result []triggerInfo
	for rows.Next() {
		var item triggerInfo
		var event, timing, level, condition, language, enabled, valid, comment, createdAt any
		if err := rows.Scan(&item.Name, &event, &timing, &level, &condition, &language, &enabled, &valid, &comment, &createdAt); err != nil {
			return nil, err
		}
		item.Event = triggerEventName(event)
		item.Timing = triggerTimingName(timing)
		item.Level = triggerLevelName(level)
		item.Condition = optionalString(xuguString(condition))
		item.Language = optionalString(xuguString(language))
		item.Enabled = optionalBool(enabled)
		item.Valid = optionalBool(valid)
		item.Comment = optionalString(xuguString(comment))
		item.CreatedAt = optionalString(xuguString(createdAt))
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) listConstraints(schema, table string) ([]constraintInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	table = strings.ToUpper(strings.TrimSpace(table))
	rows, err := s.queryRows(xuguTableConstraintsSQL, []any{schema, table})
	if err != nil {
		if isXuguMetadataUnavailableError(err) {
			return []constraintInfo{}, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)

	var result []constraintInfo
	for rows.Next() {
		var name, kind, definition, refSchema, refTable any
		var matchType, updateAction, deleteAction, deferrable, initiallyDeferred, enabled, valid, systemGenerated any
		if err := rows.Scan(&name, &kind, &definition, &refSchema, &refTable, &matchType, &updateAction, &deleteAction,
			&deferrable, &initiallyDeferred, &enabled, &valid, &systemGenerated); err != nil {
			return nil, err
		}
		item := constraintInfo{
			Name: xuguString(name), ConstraintType: xuguConstraintTypeName(xuguString(kind)), Definition: xuguString(definition),
			Columns: []string{}, RefColumns: []string{}, Deferrable: truthy(deferrable), InitiallyDeferred: truthy(initiallyDeferred),
			Enabled: truthy(enabled), Valid: truthy(valid),
		}
		if xuguString(kind) == "F" {
			item.Columns, item.RefColumns = parseForeignKeyColumns(item.Definition)
			item.RefSchema = optionalString(xuguString(refSchema))
			item.RefTable = optionalString(xuguString(refTable))
			item.MatchType = optionalString(xuguMatchTypeName(xuguString(matchType)))
			item.OnUpdate = optionalString(xuguReferentialAction(xuguString(updateAction)))
			item.OnDelete = optionalString(xuguReferentialAction(xuguString(deleteAction)))
		} else if xuguString(kind) != "C" {
			item.Columns = parseQuotedIdentifiers(item.Definition)
		}
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) listPartitions(schema, table string) ([]partitionInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	return s.listPartitionMetadata(schema, strings.ToUpper(strings.TrimSpace(table)))
}

func (s *server) listSubpartitions(schema, table string) ([]subpartitionInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	return s.listSubpartitionMetadata(schema, strings.ToUpper(strings.TrimSpace(table)))
}

func (s *server) getObjectSource(schema, name, objectType string) (map[string]any, error) {
	if strings.EqualFold(strings.TrimSpace(objectType), "SEQUENCE") {
		result, err := s.getSequenceSource(schema, name)
		if err != nil && isXuguMetadataAccessError(err) {
			return xuguUnavailableObjectSource(schema, name, objectType), nil
		}
		return result, err
	}
	if strings.EqualFold(strings.TrimSpace(objectType), "SYNONYM") {
		result, err := s.getSynonymSource(schema, name)
		if err != nil && isXuguMetadataAccessError(err) {
			return xuguUnavailableObjectSource(schema, name, objectType), nil
		}
		return result, err
	}
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
		if isXuguMetadataAccessError(err) {
			return xuguUnavailableObjectSource(schema, name, objectType), nil
		}
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

func xuguUnavailableObjectSource(schema, name, objectType string) map[string]any {
	return map[string]any{
		"name":        name,
		"object_type": objectType,
		"schema":      schema,
		"source":      fmt.Sprintf("-- XuguDB did not expose source metadata for %s.%s (%s).\n-- The object can still be listed and managed, but its source cannot be reconstructed with the current privileges.", schema, name, objectType),
		"editable":    false,
	}
}

// getSequenceSource reconstructs sequence DDL from ALL_SEQUENCES. Unlike
// programmable objects, sequences have no stored DEFINE text. Reconstructing
// the statement avoids DBMS_METADATA permissions and matches the approach used
// by the Xugu DBeaver extension.
func (s *server) getSequenceSource(schema, name string) (map[string]any, error) {
	catalogSchema, catalogName, err := s.resolveCatalogSequenceName(schema, name)
	if err != nil {
		return nil, err
	}
	rows, err := s.queryRows(xuguSequenceMetadataQuery(catalogSchema, catalogName), nil)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)

	result := map[string]any{"name": catalogName, "object_type": "SEQUENCE", "schema": catalogSchema, "source": "", "editable": false}
	if !rows.Next() {
		return result, rows.Err()
	}
	var sequence xuguSequenceMetadata
	if err := rows.Scan(
		&sequence.Schema, &sequence.Name,
		&sequence.Current, &sequence.Minimum, &sequence.Maximum, &sequence.Step,
		&sequence.Cache, &sequence.Cycle, &sequence.Comment,
	); err != nil {
		return nil, err
	}
	result["name"] = sequence.Name
	result["schema"] = sequence.Schema
	result["source"] = renderXuguSequenceDDL(sequence)
	return result, rows.Err()
}

// resolveCatalogSequenceName follows the same exact-case-first policy used by
// table DDL export. A case-insensitive lookup is only safe when it resolves to
// one catalog object; selecting the first row would export a different quoted
// sequence when catalog objects differ only by case.
func (s *server) resolveCatalogSequenceName(schema, name string) (string, string, error) {
	schema = strings.TrimSpace(schema)
	name = strings.TrimSpace(name)
	if schema == "" {
		current, err := s.currentSchema()
		if err != nil {
			return "", "", err
		}
		schema = current
	}
	if name == "" {
		return "", "", errors.New("sequence name is required")
	}
	candidates, err := s.catalogSequenceNameCandidates(xuguCatalogSequenceNameQuery(schema, name, false))
	if err != nil {
		return "", "", err
	}
	if len(candidates) > 0 {
		return selectXuguCatalogSequenceName(schema, name, candidates)
	}

	candidates, err = s.catalogSequenceNameCandidates(xuguCatalogSequenceNameQuery(schema, name, true))
	if err != nil {
		return "", "", err
	}
	return selectXuguCatalogSequenceName(schema, name, candidates)
}

func xuguSequenceMetadataQuery(schema, name string) string {
	return `
SELECT s.SCHEMA_NAME, q.SEQ_NAME,
       q.CURR_VAL, q.MIN_VAL, q.MAX_VAL, q.STEP_VAL,
       q.CACHE_VAL, q.IS_CYCLE, q.COMMENTS
FROM ALL_SEQUENCES q
JOIN ALL_SCHEMAS s ON s.DB_ID = q.DB_ID AND s.SCHEMA_ID = q.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND s.SCHEMA_NAME = ` + quoteStringLiteral(schema) + `
  AND q.SEQ_NAME = ` + quoteStringLiteral(name) + `
  AND q.IS_SYS = FALSE`
}

type xuguCatalogSequenceName struct {
	Schema string
	Name   string
}

func xuguCatalogSequenceNameQuery(schema, name string, caseInsensitive bool) string {
	schemaExpr := quoteStringLiteral(schema)
	nameExpr := quoteStringLiteral(name)
	if caseInsensitive {
		schemaExpr = quoteStringLiteral(strings.ToUpper(schema))
		nameExpr = quoteStringLiteral(strings.ToUpper(name))
		return xuguCatalogSequenceNameSelectSQL + "\n  AND UPPER(s.SCHEMA_NAME) = " + schemaExpr +
			"\n  AND UPPER(q.SEQ_NAME) = " + nameExpr
	}
	return xuguCatalogSequenceNameSelectSQL + "\n  AND s.SCHEMA_NAME = " + schemaExpr +
		"\n  AND q.SEQ_NAME = " + nameExpr
}

func (s *server) catalogSequenceNameCandidates(query string) ([]xuguCatalogSequenceName, error) {
	rows, err := s.queryRows(strings.TrimSpace(query), nil)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var candidates []xuguCatalogSequenceName
	for rows.Next() {
		var candidate xuguCatalogSequenceName
		if err := rows.Scan(&candidate.Schema, &candidate.Name); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

func selectXuguCatalogSequenceName(schema, name string, candidates []xuguCatalogSequenceName) (string, string, error) {
	for _, candidate := range candidates {
		if candidate.Schema == schema && candidate.Name == name {
			return candidate.Schema, candidate.Name, nil
		}
	}
	if len(candidates) == 1 {
		return candidates[0].Schema, candidates[0].Name, nil
	}
	if len(candidates) == 0 {
		return "", "", fmt.Errorf("sequence not found: %s.%s", schema, name)
	}
	return "", "", fmt.Errorf("sequence name is ambiguous: %s.%s; specify the catalog's exact case", schema, name)
}

func renderXuguSequenceDDL(sequence xuguSequenceMetadata) string {
	var builder strings.Builder
	builder.WriteString("CREATE SEQUENCE ")
	builder.WriteString(quoteIdentifier(sequence.Schema))
	builder.WriteByte('.')
	builder.WriteString(quoteIdentifier(sequence.Name))

	if value := xuguSequenceNumber(sequence.Step); value != "" {
		builder.WriteString("\n  INCREMENT BY ")
		builder.WriteString(value)
	}
	if value := xuguSequenceNumber(sequence.Current); value != "" {
		builder.WriteString("\n  START WITH ")
		builder.WriteString(value)
	}
	if value := xuguSequenceNumber(sequence.Minimum); value != "" {
		builder.WriteString("\n  MINVALUE ")
		builder.WriteString(value)
	} else {
		builder.WriteString("\n  NOMINVALUE")
	}
	if value := xuguSequenceNumber(sequence.Maximum); value != "" {
		builder.WriteString("\n  MAXVALUE ")
		builder.WriteString(value)
	} else {
		builder.WriteString("\n  NOMAXVALUE")
	}
	if value := xuguSequenceNumber(sequence.Cache); value != "" && xuguInt(sequence.Cache) > 1 {
		builder.WriteString("\n  CACHE ")
		builder.WriteString(value)
	} else {
		builder.WriteString("\n  NOCACHE")
	}
	if truthy(sequence.Cycle) {
		builder.WriteString("\n  CYCLE")
	} else {
		builder.WriteString("\n  NOCYCLE")
	}
	if comment := strings.TrimSpace(xuguString(sequence.Comment)); comment != "" {
		builder.WriteString("\n  COMMENT ")
		builder.WriteString(quoteStringLiteral(comment))
	}
	builder.WriteString(";")
	return builder.String()
}

// getSynonymSource reconstructs synonym DDL from ALL_SYNONYMS. Public
// synonyms are exposed in the reserved database-global scope and therefore
// use PUBLIC syntax without a schema qualifier.
func (s *server) getSynonymSource(schema, name string) (map[string]any, error) {
	synonym, err := s.resolveCatalogSynonym(schema, name)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(synonym.TargetName) == "" {
		return nil, fmt.Errorf("synonym target is missing: %s.%s", synonym.Schema, synonym.Name)
	}

	var builder strings.Builder
	if synonym.Public {
		builder.WriteString("CREATE PUBLIC SYNONYM ")
		builder.WriteString(quoteIdentifier(synonym.Name))
	} else {
		builder.WriteString("CREATE SYNONYM ")
		builder.WriteString(quoteIdentifier(synonym.Schema))
		builder.WriteByte('.')
		builder.WriteString(quoteIdentifier(synonym.Name))
	}
	builder.WriteString("\nFOR ")
	if targetSchema := strings.TrimSpace(synonym.TargetSchema.String); targetSchema != "" {
		builder.WriteString(quoteIdentifier(targetSchema))
		builder.WriteByte('.')
	}
	builder.WriteString(quoteIdentifier(synonym.TargetName))
	builder.WriteString(";")

	return map[string]any{
		"name":        synonym.Name,
		"object_type": "SYNONYM",
		"schema":      synonym.Schema,
		"source":      builder.String(),
		"editable":    false,
	}, nil
}

// resolveCatalogSynonym applies exact matching before a case-insensitive
// fallback. This preserves quoted identifiers and refuses an ambiguous lookup
// instead of silently generating DDL for a different alias.
func (s *server) resolveCatalogSynonym(schema, name string) (xuguCatalogSynonym, error) {
	schema = strings.TrimSpace(schema)
	name = strings.TrimSpace(name)
	if schema == "" {
		current, err := s.currentSchema()
		if err != nil {
			return xuguCatalogSynonym{}, err
		}
		schema = current
	}
	if name == "" {
		return xuguCatalogSynonym{}, errors.New("synonym name is required")
	}

	candidates, err := s.catalogSynonymCandidates(xuguCatalogSynonymQuery(schema, name, false))
	if err != nil {
		return xuguCatalogSynonym{}, err
	}
	if len(candidates) == 0 {
		candidates, err = s.catalogSynonymCandidates(xuguCatalogSynonymQuery(schema, name, true))
		if err != nil {
			return xuguCatalogSynonym{}, err
		}
	}
	return selectXuguCatalogSynonym(schema, name, candidates)
}

func xuguCatalogSynonymQuery(schema, name string, caseInsensitive bool) string {
	schemaExpr := quoteStringLiteral(schema)
	nameExpr := quoteStringLiteral(name)
	publicScope := isXuguPublicSynonymScope(schema)
	if caseInsensitive {
		nameExpr = quoteStringLiteral(strings.ToUpper(name))
		if publicScope {
			return xuguCatalogSynonymSelectSQL + "\n  AND y.IS_PUBLIC = TRUE\n  AND UPPER(y.SYNO_NAME) = " + nameExpr
		}
		schemaExpr = quoteStringLiteral(strings.ToUpper(schema))
		return xuguCatalogSynonymSelectSQL + "\n  AND y.IS_PUBLIC = FALSE\n  AND UPPER(s.SCHEMA_NAME) = " + schemaExpr +
			"\n  AND UPPER(y.SYNO_NAME) = " + nameExpr
	}
	if publicScope {
		return xuguCatalogSynonymSelectSQL + "\n  AND y.IS_PUBLIC = TRUE\n  AND y.SYNO_NAME = " + nameExpr
	}
	return xuguCatalogSynonymSelectSQL + "\n  AND y.IS_PUBLIC = FALSE\n  AND s.SCHEMA_NAME = " + schemaExpr +
		"\n  AND y.SYNO_NAME = " + nameExpr
}

func (s *server) catalogSynonymCandidates(query string) ([]xuguCatalogSynonym, error) {
	rows, err := s.queryRows(strings.TrimSpace(query), nil)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)

	var candidates []xuguCatalogSynonym
	for rows.Next() {
		var candidate xuguCatalogSynonym
		var schema sql.NullString
		if err := rows.Scan(&schema, &candidate.Name, &candidate.TargetSchema, &candidate.TargetName, &candidate.Public); err != nil {
			return nil, err
		}
		if candidate.Public {
			candidate.Schema = xuguPublicSynonymScope
		} else {
			candidate.Schema = schema.String
		}
		candidates = append(candidates, candidate)
	}
	return candidates, rows.Err()
}

func selectXuguCatalogSynonym(schema, name string, candidates []xuguCatalogSynonym) (xuguCatalogSynonym, error) {
	for _, candidate := range candidates {
		if candidate.Schema == schema && candidate.Name == name {
			return candidate, nil
		}
	}
	if len(candidates) == 1 {
		return candidates[0], nil
	}
	if len(candidates) == 0 {
		return xuguCatalogSynonym{}, fmt.Errorf("synonym not found: %s.%s", schema, name)
	}
	return xuguCatalogSynonym{}, fmt.Errorf("synonym name is ambiguous: %s.%s; specify the catalog's exact case", schema, name)
}

func xuguSequenceNumber(value any) string {
	return strings.TrimSpace(xuguString(value))
}

func (s *server) getTableDDL(schema, table string) (string, error) {
	// Resolve the catalog's stored casing before issuing exact metadata lookups,
	// so emitted DDL quotes the original names and preserves double-quoted
	// schema/table/column spellings.
	if strings.TrimSpace(schema) != "" {
		if err := s.setSchema(schema); err != nil {
			if !isXuguMetadataAccessError(err) {
				return "", err
			}
		}
	}
	catalogSchema, catalogTable, err := s.resolveCatalogTableName(schema, table)
	if err != nil {
		if isXuguMetadataAccessError(err) || isXuguTableNotFoundError(err) {
			fallbackSchema, fallbackTable, fallbackErr := s.fallbackTableIdentity(schema, table)
			if fallbackErr != nil {
				return "", fallbackErr
			}
			ddl, directErr := s.buildFallbackTableDDL(fallbackSchema, fallbackTable)
			if directErr == nil {
				return ddl, nil
			}
			if isXuguMetadataAccessError(directErr) {
				return xuguUnavailableTableDDL(fallbackSchema, fallbackTable), nil
			}
			return "", directErr
		}
		return "", err
	}
	if err := s.setSchema(catalogSchema); err != nil {
		if !isXuguMetadataAccessError(err) {
			return "", err
		}
	}
	// DBMS_METADATA.GET_DDL can block indefinitely on XuguDB, even when the
	// table metadata itself is accessible. Reconstruct the DDL from the same
	// ALL_* catalog views used by the object browser instead.
	ddl, err := s.buildTableDDL(catalogSchema, catalogTable)
	if err != nil {
		return "", err
	}
	return s.appendTableIndexDDL(catalogSchema, catalogTable, ddl), nil
}

func (s *server) buildFallbackTableDDL(schema, table string) (string, error) {
	columns, err := s.columnsFromSelect(schema, table, map[string]bool{})
	if err != nil {
		return "", err
	}
	if len(columns) == 0 {
		return "", fmt.Errorf("table not found: %s.%s", schema, table)
	}
	return renderXuguTableDDL(schema, table, columns, xuguTableMetadata{}, nil, nil, nil, nil), nil
}

func xuguUnavailableTableDDL(schema, table string) string {
	return fmt.Sprintf("-- XuguDB did not expose enough metadata to reconstruct %s.%s.\n-- The table may still be readable, but its DDL requires additional metadata privileges.", schema, table)
}

type xuguCatalogTableName struct {
	Schema string
	Table  string
}

// resolveCatalogTableName returns SCHEMA_NAME/TABLE_NAME exactly as stored in
// ALL_SCHEMAS/ALL_TABLES. The lookup accepts a case-insensitive input only
// when it has a single catalog candidate; otherwise it requires the exact
// stored spelling rather than silently exporting a different quoted object.
func (s *server) resolveCatalogTableName(schema, table string) (string, string, error) {
	schema = strings.TrimSpace(schema)
	table = strings.TrimSpace(table)
	if schema == "" {
		current, err := s.currentSchema()
		if err != nil {
			return "", "", err
		}
		schema = current
	}
	if table == "" {
		return "", "", errors.New("table is required")
	}
	candidates, err := s.catalogTableNameCandidates(xuguCatalogTableNameQuery(schema, table, false))
	if err != nil {
		return "", "", err
	}
	if len(candidates) > 0 {
		return selectXuguCatalogTableName(schema, table, candidates)
	}

	// This Xugu Go driver version does not bind mixed-case identifiers reliably
	// inside catalog predicates. The query builder escapes literals and keeps the
	// exact lookup above as the priority; this fallback is only for unquoted input.
	candidates, err = s.catalogTableNameCandidates(xuguCatalogTableNameQuery(schema, table, true))
	if err != nil {
		return "", "", err
	}
	return selectXuguCatalogTableName(schema, table, candidates)
}

func xuguCatalogTableNameQuery(schema, table string, caseInsensitive bool) string {
	schemaExpr := quoteStringLiteral(schema)
	tableExpr := quoteStringLiteral(table)
	if caseInsensitive {
		schemaExpr = quoteStringLiteral(strings.ToUpper(schema))
		tableExpr = quoteStringLiteral(strings.ToUpper(table))
		return xuguCatalogTableNameSelectSQL + "\nWHERE s.DB_ID = CURRENT_DB_ID\n  AND UPPER(s.SCHEMA_NAME) = " + schemaExpr +
			"\n  AND UPPER(t.TABLE_NAME) = " + tableExpr
	}
	return xuguCatalogTableNameSelectSQL + "\nWHERE s.DB_ID = CURRENT_DB_ID\n  AND s.SCHEMA_NAME = " + schemaExpr +
		"\n  AND t.TABLE_NAME = " + tableExpr
}

// xuguTableCatalogQuery substitutes the two schema/table placeholders used by
// the table metadata templates. Xugu's Go driver does not reliably bind
// mixed-case catalog identifiers, so values are escaped as SQL literals only
// after resolveCatalogTableName has located the intended catalog object.
func xuguTableCatalogQuery(query, schema, table string) string {
	query = strings.Replace(query, "?", quoteStringLiteral(schema), 1)
	return strings.Replace(query, "?", quoteStringLiteral(table), 1)
}

func (s *server) catalogTableNameCandidates(query string) ([]xuguCatalogTableName, error) {
	rows, err := s.queryRows(strings.TrimSpace(query), nil)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var candidates []xuguCatalogTableName
	for rows.Next() {
		var candidate xuguCatalogTableName
		if err := rows.Scan(&candidate.Schema, &candidate.Table); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

func selectXuguCatalogTableName(schema, table string, candidates []xuguCatalogTableName) (string, string, error) {
	for _, candidate := range candidates {
		if candidate.Schema == schema && candidate.Table == table {
			return candidate.Schema, candidate.Table, nil
		}
	}
	if len(candidates) == 1 {
		return candidates[0].Schema, candidates[0].Table, nil
	}
	if len(candidates) == 0 {
		return "", "", fmt.Errorf("table not found: %s.%s", schema, table)
	}
	return "", "", fmt.Errorf("table name is ambiguous: %s.%s; specify the catalog's exact case", schema, table)
}

func (s *server) getExplainInfo(sqlText string) (string, error) {
	if strings.TrimSpace(sqlText) == "" {
		return "", errors.New("sql is required")
	}
	rows, err := s.queryRowsWithTimeoutOnce("EXPLAIN "+trimStatementSQL(sqlText), nil, 0)
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

func (s *server) executeTransaction(params map[string]json.RawMessage) (result queryResult, err error) {
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
	defer func() {
		err = s.finishActiveOperation(cancel, 0, err)
	}()
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
		execResult, err := tx.ExecContext(ctx, statement)
		if err != nil {
			tx.Rollback()
			return queryResult{}, err
		}
		count, _ := execResult.RowsAffected()
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
	rows, err := s.queryRowsWithTimeoutOnce(sqlText, nil, opts.TimeoutSecs)
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
	execResult, err := db.ExecContext(ctx, sqlText)
	err = s.finishActiveOperation(cancel, opts.TimeoutSecs, err)
	if err != nil {
		return queryResult{}, err
	}
	affected, _ := execResult.RowsAffected()
	return queryResult{Columns: []string{}, ColumnTypes: []string{}, Rows: [][]any{}, AffectedRows: affected, ExecutionTimeMS: time.Since(start).Milliseconds()}, nil
}

func (s *server) executeSelect(sqlText string, maxRows int, timeoutSecs int) (queryResult, error) {
	rows, err := s.queryRowsWithTimeoutOnce(sqlText, nil, timeoutSecs)
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
	return s.execWithReconnect("SET SCHEMA " + quoteIdentifier(schema))
}

func (s *server) queryRows(sqlText string, args []any) (*sql.Rows, error) {
	return s.queryRowsWithTimeout(sqlText, args, 0)
}

func (s *server) queryRowsWithTimeout(sqlText string, args []any, timeoutSecs int) (*sql.Rows, error) {
	rows, err := s.queryRowsWithTimeoutOnce(sqlText, args, timeoutSecs)
	if err == nil || !isXuguConnectionClosedError(err) {
		return rows, err
	}
	// A denied ALL_* metadata view can terminate the current Xugu session.
	// Re-open only the business session and retry this statement once. The
	// caller still gets the original error if the fresh connection cannot be
	// established, so real network/authentication failures remain visible.
	if reconnectErr := s.reconnectBusinessSession(); reconnectErr != nil {
		return nil, err
	}
	return s.queryRowsWithTimeoutOnce(sqlText, args, timeoutSecs)
}

func (s *server) queryRowsWithTimeoutOnce(sqlText string, args []any, timeoutSecs int) (*sql.Rows, error) {
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
	canceled := s.activeCanceled
	s.activeTimedOut = false
	s.activeCanceled = false
	if queryErr == nil && !timedOut && !canceled {
		s.activeRows[rows] = cancel
	}
	s.activeCancelMu.Unlock()
	if queryErr != nil || timedOut || canceled {
		cancel()
		if rows != nil {
			_ = rows.Close()
		}
		queryErr = xuguOperationResultError(timedOut, canceled, timeoutSecs, queryErr)
	}
	return rows, queryErr
}

func (s *server) reconnectBusinessSession() error {
	params := s.params
	if strings.TrimSpace(params.Host) == "" && strings.TrimSpace(params.ConnectionString) == "" {
		return errors.New("cannot reconnect Xugu session without connection parameters")
	}
	currentDatabase := s.currentDatabase
	if _, err := s.connectWithControl(params, nil, false); err != nil {
		return err
	}
	return s.restoreBusinessSessionDatabase(currentDatabase)
}

func (s *server) restoreBusinessSessionDatabase(database string) error {
	if strings.TrimSpace(database) == "" {
		return nil
	}
	return s.useDatabase(database)
}

func (s *server) execWithReconnect(statement string) error {
	db, err := s.requireDB()
	if err != nil {
		return err
	}
	ctx, cancel := s.beginActiveOperation()
	_, execErr := db.ExecContext(ctx, statement)
	execErr = s.finishActiveOperation(cancel, 0, execErr)
	if execErr == nil || !isXuguConnectionClosedError(execErr) {
		return execErr
	}
	if reconnectErr := s.reconnectBusinessSession(); reconnectErr != nil {
		return execErr
	}
	db, err = s.requireDB()
	if err != nil {
		return err
	}
	ctx, cancel = s.beginActiveOperation()
	_, execErr = db.ExecContext(ctx, statement)
	execErr = s.finishActiveOperation(cancel, 0, execErr)
	return execErr
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
	s.activeCanceled = false
	s.activeCancelMu.Unlock()
	return ctx, cancel
}

func (s *server) endActiveOperation(cancel context.CancelFunc) {
	_ = s.finishActiveOperation(cancel, 0, nil)
}

func (s *server) finishActiveOperation(cancel context.CancelFunc, timeoutSecs int, operationErr error) error {
	s.activeCancelMu.Lock()
	s.activeCancel = nil
	if s.activeTimer != nil {
		s.activeTimer.Stop()
		s.activeTimer = nil
	}
	timedOut := s.activeTimedOut
	canceled := s.activeCanceled
	s.activeTimedOut = false
	s.activeCanceled = false
	s.activeCancelMu.Unlock()
	cancel()
	return xuguOperationResultError(timedOut, canceled, timeoutSecs, operationErr)
}

func xuguOperationResultError(timedOut, canceled bool, timeoutSecs int, operationErr error) error {
	if timedOut {
		if operationErr != nil {
			return fmt.Errorf("%w after %ds: %v", errXuguOperationTimeout, timeoutSecs, operationErr)
		}
		return fmt.Errorf("%w after %ds", errXuguOperationTimeout, timeoutSecs)
	}
	if canceled {
		if operationErr != nil {
			return fmt.Errorf("%w: %v", errXuguOperationCanceled, operationErr)
		}
		return errXuguOperationCanceled
	}
	return operationErr
}

func (s *server) cancelActiveQuery() {
	s.activeCancelMu.Lock()
	cancels := make([]context.CancelFunc, 0, len(s.activeRows)+1)
	if s.activeCancel != nil {
		if !s.activeTimedOut {
			s.activeCanceled = true
			// Explicit cancellation won the race. Disable the watchdog so a
			// slow driver return cannot relabel this operation as a timeout.
			if s.activeTimer != nil {
				s.activeTimer.Stop()
				s.activeTimer = nil
			}
		}
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
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(v.VIEW_NAME) = UPPER(?)`, []any{schema, name}, nil
	case "TRIGGER":
		return `
SELECT TO_CHAR(t.DEFINE)
FROM ALL_TRIGGERS t
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(t.TRIG_NAME) = UPPER(?)`, []any{schema, name}, nil
	case "PROCEDURE", "FUNCTION":
		return `
SELECT TO_CHAR(p.DEFINE)
FROM ALL_PROCEDURES p
JOIN ALL_SCHEMAS s ON s.DB_ID = p.DB_ID AND s.SCHEMA_ID = p.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(p.PROC_NAME) = UPPER(?)`, []any{schema, name}, nil
	case "PACKAGE":
		return `
SELECT COALESCE(TO_CHAR(k.SPEC), '')
FROM ALL_PACKAGES k
JOIN ALL_SCHEMAS s ON s.DB_ID = k.DB_ID AND s.SCHEMA_ID = k.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(k.PACK_NAME) = UPPER(?)`, []any{schema, name}, nil
	case "PACKAGE BODY", "PACKAGE_BODY":
		return `
SELECT COALESCE(TO_CHAR(k.BODY), '')
FROM ALL_PACKAGES k
JOIN ALL_SCHEMAS s ON s.DB_ID = k.DB_ID AND s.SCHEMA_ID = k.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(k.PACK_NAME) = UPPER(?)`, []any{schema, name}, nil
	case "TYPE":
		return `
SELECT COALESCE(TO_CHAR(u.SPEC), '')
FROM ALL_TYPES u
JOIN ALL_SCHEMAS s ON s.DB_ID = u.DB_ID AND s.SCHEMA_ID = u.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(u.TYPE_NAME) = UPPER(?)`, []any{schema, name}, nil
	case "TYPE BODY", "TYPE_BODY":
		return `
SELECT COALESCE(TO_CHAR(u.BODY), '')
FROM ALL_TYPES u
JOIN ALL_SCHEMAS s ON s.DB_ID = u.DB_ID AND s.SCHEMA_ID = u.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?) AND UPPER(u.TYPE_NAME) = UPPER(?)
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
		if !isXuguMetadataAccessError(err) {
			return "", err
		}
		metadata = xuguTableMetadata{}
	}
	identities, err := s.tableIdentities(schema, table)
	if err != nil {
		if !isXuguMetadataAccessError(err) {
			return "", err
		}
		identities = map[string]xuguIdentityInfo{}
	}
	constraints, err := s.tableConstraints(schema, table)
	if err != nil {
		if !isXuguMetadataAccessError(err) {
			return "", err
		}
		constraints = []xuguConstraintInfo{}
	}
	foreignKeys, err := s.tableForeignKeys(schema, table)
	if err != nil {
		if !isXuguMetadataAccessError(err) {
			return "", err
		}
		foreignKeys = []xuguConstraintInfo{}
	}
	partitions, err := s.tablePartitions(schema, table, false)
	if err != nil {
		if !isXuguMetadataAccessError(err) {
			return "", err
		}
		partitions = []xuguPartitionInfo{}
	}
	subpartitions, err := s.tablePartitions(schema, table, true)
	if err != nil {
		if !isXuguMetadataAccessError(err) {
			return "", err
		}
		subpartitions = []xuguPartitionInfo{}
	}
	allConstraints := make([]xuguConstraintInfo, 0, len(constraints)+len(foreignKeys))
	allConstraints = append(allConstraints, constraints...)
	allConstraints = append(allConstraints, foreignKeys...)
	return renderXuguTableDDL(schema, table, columns, metadata, identities, allConstraints, partitions, subpartitions), nil
}

func (s *server) tableMetadata(schema, table string) (xuguTableMetadata, error) {
	rows, err := s.queryRows(xuguTableCatalogQuery(xuguTableMetadataSQL, schema, table), nil)
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
	rows, err := s.queryRows(xuguTableCatalogQuery(xuguTableIdentitySQL, schema, table), nil)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	result := map[string]xuguIdentityInfo{}
	for rows.Next() {
		var column, start, step, systemGenerated any
		if err := rows.Scan(&column, &start, &step, &systemGenerated); err != nil {
			return nil, err
		}
		item := xuguIdentityInfo{
			Column:          xuguString(column),
			Start:           int64(xuguInt(start)),
			Step:            int64(xuguInt(step)),
			SystemGenerated: truthy(systemGenerated),
		}
		result[item.Column] = item
	}
	return result, rows.Err()
}

func (s *server) tableConstraints(schema, table string) ([]xuguConstraintInfo, error) {
	return s.readTableConstraints(xuguTableConstraintsSQL, schema, table)
}

func (s *server) tableForeignKeys(schema, table string) ([]xuguConstraintInfo, error) {
	return s.readTableConstraints(xuguTableForeignKeysSQL, schema, table)
}

func (s *server) readTableConstraints(query, schema, table string) ([]xuguConstraintInfo, error) {
	rows, err := s.queryRows(xuguTableCatalogQuery(query, schema, table), nil)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var result []xuguConstraintInfo
	for rows.Next() {
		var item xuguConstraintInfo
		var name, constraintType, definition, referenceSchema, referenceTable any
		var matchType, updateAction, deleteAction, deferrable, initiallyDeferred, enabled, valid, systemGenerated any
		if err := rows.Scan(&name, &constraintType, &definition, &referenceSchema, &referenceTable,
			&matchType, &updateAction, &deleteAction, &deferrable, &initiallyDeferred, &enabled, &valid, &systemGenerated); err != nil {
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
		item.Valid = truthy(valid)
		item.SystemGenerated = truthy(systemGenerated)
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) tablePartitions(schema, table string, subpartition bool) ([]xuguPartitionInfo, error) {
	query := xuguTablePartitionsSQL
	if subpartition {
		query = xuguTableSubpartitionsSQL
	}
	rows, err := s.queryRows(xuguTableCatalogQuery(query, schema, table), nil)
	if err != nil {
		return nil, err
	}
	defer s.closeRows(rows)
	var result []xuguPartitionInfo
	for rows.Next() {
		var position, name, value, ignored1, ignored2, ignored3, ignored4, ignored5 any
		if subpartition {
			if err := rows.Scan(&position, &name, &value, &ignored1, &ignored2); err != nil {
				return nil, err
			}
		} else if err := rows.Scan(&position, &name, &value, &ignored1, &ignored2, &ignored3, &ignored4, &ignored5); err != nil {
			return nil, err
		}
		result = append(result, xuguPartitionInfo{Name: xuguString(name), Value: xuguString(value)})
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) listPartitionMetadata(schema, table string) ([]partitionInfo, error) {
	rows, err := s.queryRows(xuguTableCatalogQuery(xuguTablePartitionsSQL, schema, table), nil)
	if err != nil {
		if isXuguMetadataUnavailableError(err) {
			return []partitionInfo{}, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)
	var result []partitionInfo
	for rows.Next() {
		var no, name, value, online, partitionType, partitionKey, autoType, autoSpan any
		if err := rows.Scan(&no, &name, &value, &online, &partitionType, &partitionKey, &autoType, &autoSpan); err != nil {
			return nil, err
		}
		item := partitionInfo{Name: xuguString(name), Position: xuguInt(no), Value: xuguString(value),
			PartitionType: xuguPartitionType(xuguInt(partitionType)), PartitionKey: xuguString(partitionKey)}
		if value := xuguString(online); value != "" {
			isOnline := truthy(online)
			item.Online = &isOnline
		}
		if name := xuguAutoPartitionUnit(xuguInt(autoType)); name != "" {
			item.AutoPartitionType = &name
		}
		if span := xuguInt(autoSpan); span > 0 {
			item.AutoPartitionSpan = &span
		}
		result = append(result, item)
	}
	return emptyIfNil(result), rows.Err()
}

func (s *server) listSubpartitionMetadata(schema, table string) ([]subpartitionInfo, error) {
	rows, err := s.queryRows(xuguTableCatalogQuery(xuguTableSubpartitionsSQL, schema, table), nil)
	if err != nil {
		if isXuguMetadataUnavailableError(err) {
			return []subpartitionInfo{}, nil
		}
		return nil, err
	}
	defer s.closeRows(rows)
	var result []subpartitionInfo
	for rows.Next() {
		var no, name, value, partitionType, partitionKey any
		if err := rows.Scan(&no, &name, &value, &partitionType, &partitionKey); err != nil {
			return nil, err
		}
		result = append(result, subpartitionInfo{Name: xuguString(name), Position: xuguInt(no), Value: xuguString(value),
			PartitionType: xuguPartitionType(xuguInt(partitionType)), PartitionKey: xuguString(partitionKey)})
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
		if identity, ok := identities[column.Name]; ok {
			item.WriteString(fmt.Sprintf(" IDENTITY(%d,%d)", identity.Start, identity.Step))
		}
		if column.ColumnDefault != nil {
			if def := normalizeXuguDefaultExpr(strings.TrimSpace(*column.ColumnDefault), column.DataType); def != "" {
				item.WriteString(" DEFAULT ")
				switch column.DefaultOnNull {
				case 1:
					// ON_NULL=1 means that an explicit NULL is replaced during insert.
					// The explicit spelling also covers the legacy DEFAULT ON NULL form.
					item.WriteString("ON NULL FOR INSERT ONLY ")
				case 2:
					item.WriteString("ON NULL FOR INSERT AND UPDATE ")
				}
				item.WriteString(def)
			}
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
	// Inline only constraints that are valid inside CREATE TABLE. Foreign keys
	// must be added with ALTER TABLE: Xugu rejects self-referencing FKs (and
	// any FK whose parent is not yet visible) during CREATE, matching DBeaver's
	// xugu-metadata exporter which always emits ALTER for F/PK/CHECK extras.
	var foreignKeys []xuguConstraintInfo
	for _, constraint := range constraints {
		if strings.EqualFold(strings.TrimSpace(constraint.Type), "F") {
			foreignKeys = append(foreignKeys, constraint)
			continue
		}
		// Xugu exposes the implicit unique key that it creates for every
		// IDENTITY column through ALL_CONSTRAINTS. Re-emitting it as an
		// explicit UNIQUE clause makes CREATE TABLE fail with E5170 because
		// the IDENTITY definition already supplies that uniqueness.
		if shouldSkipXuguIdentityUniqueConstraint(constraint, identities) {
			continue
		}
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
	for _, constraint := range foreignKeys {
		if item := renderXuguForeignKeyAlterDDL(schema, table, constraint); item != "" {
			builder.WriteString(";\n\n")
			builder.WriteString(item)
		}
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
	// A table DDL response is also used as a standalone script. Do not rely on
	// appendTableIndexDDL to terminate the CREATE/ALTER statement: tables with
	// no independent indexes must remain directly executable as well.
	return terminateDDLScript(builder.String())
}

func shouldSkipXuguIdentityUniqueConstraint(constraint xuguConstraintInfo, identities map[string]xuguIdentityInfo) bool {
	if !strings.EqualFold(strings.TrimSpace(constraint.Type), "U") || len(identities) == 0 {
		return false
	}
	columns := parseQuotedIdentifiers(constraint.Definition)
	if len(columns) != 1 {
		return false
	}
	identity, isIdentity := identities[columns[0]]
	// Both catalog objects must be system-generated: an identity column can
	// still have a separate, user-declared UNIQUE constraint on the same column.
	return isIdentity && identity.SystemGenerated && constraint.SystemGenerated
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
		// Foreign keys are rendered as ALTER TABLE statements; see renderXuguForeignKeyAlterDDL.
		return ""
	default:
		return ""
	}
}

// renderXuguForeignKeyAlterDDL emits FK constraints after CREATE TABLE. Self-
// referencing trees (e.g. SHOP_CATEGORIES.PARENT_ID -> CATEGORY_ID) fail when
// declared inline because the table does not exist yet during CREATE validation.
func renderXuguForeignKeyAlterDDL(schema, table string, constraint xuguConstraintInfo) string {
	name := strings.TrimSpace(constraint.Name)
	definition := strings.TrimSpace(constraint.Definition)
	if name == "" || definition == "" {
		return ""
	}
	localColumns, referencedColumns := parseForeignKeyColumns(definition)
	if len(localColumns) == 0 || len(referencedColumns) == 0 || strings.TrimSpace(constraint.ReferenceTable) == "" {
		return ""
	}
	var builder strings.Builder
	builder.WriteString("ALTER TABLE ")
	builder.WriteString(quoteIdentifier(schema))
	builder.WriteByte('.')
	builder.WriteString(quoteIdentifier(table))
	builder.WriteString(" ADD CONSTRAINT ")
	builder.WriteString(quoteIdentifier(name))
	builder.WriteString(" FOREIGN KEY (")
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

func xuguMatchTypeName(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "A":
		return "FULL"
	case "P":
		return "PARTIAL"
	case "U":
		return "SIMPLE"
	default:
		return ""
	}
}

func xuguConstraintTypeName(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "P":
		return "PRIMARY KEY"
	case "U":
		return "UNIQUE"
	case "C":
		return "CHECK"
	case "F":
		return "FOREIGN KEY"
	case "N":
		return "NOT NULL"
	case "D":
		return "DEFAULT"
	case "R":
		return "REFERENCED KEY"
	default:
		return strings.TrimSpace(value)
	}
}

func xuguAutoPartitionUnit(value int) string {
	return map[int]string{1: "YEAR", 2: "MONTH", 3: "DAY", 4: "HOUR"}[value]
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func optionalBool(value any) *bool {
	if normalizeValue(value) == nil {
		return nil
	}
	result := truthy(value)
	return &result
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
	// PRIMARY KEY / UNIQUE constraints already create backing indexes. Replaying
	// CREATE UNIQUE INDEX for those columns fails with "identical index exists".
	var uniqueConstraintColumns [][]string
	if constraints, cerr := s.tableConstraints(schema, table); cerr == nil {
		uniqueConstraintColumns = uniqueKeyColumnSets(constraints)
	}
	var builder strings.Builder
	for _, index := range indexes {
		if shouldSkipIndexForTableDDL(index, uniqueConstraintColumns) {
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
		for i, key := range xuguIndexKeysForDDL(index) {
			if i > 0 {
				builder.WriteString(", ")
			}
			builder.WriteString(renderXuguIndexKey(key))
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

// uniqueKeyColumnSets returns column lists for PRIMARY KEY and UNIQUE constraints.
// Xugu stores those definitions as quoted identifiers inside ALL_CONSTRAINTS.DEFINE.
func uniqueKeyColumnSets(constraints []xuguConstraintInfo) [][]string {
	var result [][]string
	for _, constraint := range constraints {
		switch strings.ToUpper(strings.TrimSpace(constraint.Type)) {
		case "P", "U":
			columns := parseQuotedIdentifiers(constraint.Definition)
			if len(columns) == 0 {
				continue
			}
			result = append(result, columns)
		}
	}
	return result
}

// shouldSkipIndexForTableDDL drops indexes that CREATE TABLE already materializes
// through PRIMARY KEY / UNIQUE constraints, so the exported script can be replayed.
func shouldSkipIndexForTableDDL(index indexInfo, uniqueConstraintColumns [][]string) bool {
	if index.IsPrimary || len(index.Columns) == 0 {
		return true
	}
	if !index.IsUnique {
		return false
	}
	indexColumns, plainColumns := xuguPlainIndexColumns(index)
	if !plainColumns {
		return false
	}
	for _, constraintColumns := range uniqueConstraintColumns {
		if sameColumnList(indexColumns, constraintColumns) {
			return true
		}
	}
	return false
}

func sameColumnList(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if strings.TrimSpace(left[i]) != strings.TrimSpace(right[i]) {
			return false
		}
	}
	return true
}

// normalizeXuguDefaultExpr only rewrites complete catalog tokens whose Xugu
// equivalents are known to be semantically identical. In particular, do not
// lowercase an expression or replace text inside a string literal: exported DDL
// must preserve metadata when a transformation cannot be proven safe.
func normalizeXuguDefaultExpr(value, _ string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if inner, ok := unquoteXuguIdentifier(trimmed); ok {
		inner = strings.TrimSpace(inner)
		switch strings.ToUpper(inner) {
		case "SYSDATE", "CURRENT_DATE", "CURRENT_TIMESTAMP", "CURRENT_TIME", "USER", "UID", "SYS_GUID":
			return strings.ToUpper(inner)
		}
	}
	// UUID() appears in catalog metadata from supported migrations. Transform
	// only the entire function token, never a substring inside a literal or a
	// larger expression.
	if strings.EqualFold(trimmed, "UUID()") {
		return "SYS_GUID()"
	}
	if strings.EqualFold(trimmed, "(GETDATE())") || strings.EqualFold(trimmed, "sysdate") {
		return "SYSDATE"
	}
	// Catalog sometimes stores unary minus with a space: "- (1)" -> "-1".
	if compact := compactUnaryMinusDefault(trimmed); compact != "" {
		return compact
	}
	return trimmed
}

func compactUnaryMinusDefault(value string) string {
	// Match patterns like "- (1)" / "- ( 12 )" produced by some migrations.
	match := unaryMinusDefaultRegexp.FindStringSubmatch(strings.TrimSpace(value))
	if len(match) != 2 {
		return ""
	}
	return "-" + match[1]
}

func (s *server) tableComment(schema, table string) (string, error) {
	rows, err := s.queryRows(`
SELECT t.COMMENTS
FROM ALL_TABLES t
JOIN ALL_SCHEMAS s ON s.DB_ID = t.DB_ID AND s.SCHEMA_ID = t.SCHEMA_ID
WHERE s.DB_ID = CURRENT_DB_ID
  AND UPPER(s.SCHEMA_NAME) = UPPER(?)
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

func terminateDDLScript(ddl string) string {
	ddl = strings.TrimRight(ddl, "\r\n\t ")
	if ddl == "" || strings.HasSuffix(ddl, ";") {
		return ddl
	}
	return ddl + ";"
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

var unaryMinusDefaultRegexp = regexp.MustCompile(`^-\s*\(\s*([0-9]+(?:\.[0-9]+)?)\s*\)$`)

// parseQuotedIdentifiers is a small SQL lexer for delimited identifiers. A
// doubled double quote represents one quote inside an identifier, so a regular
// expression such as "([^\"]+)" is insufficient for keys like "a""b".
func parseQuotedIdentifiers(value string) []string {
	var result []string
	for i := 0; i < len(value); {
		if value[i] != '"' {
			i++
			continue
		}
		identifier, next, ok := readXuguQuotedIdentifier(value, i)
		if !ok {
			break
		}
		result = append(result, identifier)
		i = next
	}
	return emptyIfNil(result)
}

func unquoteXuguIdentifier(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if len(value) < 2 || value[0] != '"' {
		return "", false
	}
	identifier, next, ok := readXuguQuotedIdentifier(value, 0)
	return identifier, ok && strings.TrimSpace(value[next:]) == ""
}

func readXuguQuotedIdentifier(value string, start int) (string, int, bool) {
	if start >= len(value) || value[start] != '"' {
		return "", start, false
	}
	var builder strings.Builder
	for i := start + 1; i < len(value); i++ {
		if value[i] != '"' {
			builder.WriteByte(value[i])
			continue
		}
		if i+1 < len(value) && value[i+1] == '"' {
			builder.WriteByte('"')
			i++
			continue
		}
		return builder.String(), i + 1, true
	}
	return "", start, false
}

func parseIndexKeys(value string) []string {
	return indexKeyDisplayNames(parseXuguIndexKeys(value))
}

func parseXuguIndexKeys(value string) []xuguIndexKey {
	parts := splitXuguTopLevel(value, ',')
	keys := make([]xuguIndexKey, 0, len(parts))
	for _, part := range parts {
		if key, ok := parseXuguIndexKey(part); ok {
			keys = append(keys, key)
		}
	}
	return emptyIfNil(keys)
}

func parseXuguIndexKey(value string) (xuguIndexKey, bool) {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return xuguIndexKey{}, false
	}
	key := xuguIndexKey{Raw: raw}
	if identifier, next, ok := readXuguQuotedIdentifier(raw, 0); ok {
		remainder := strings.TrimSpace(raw[next:])
		switch strings.ToUpper(remainder) {
		case "":
			key.Column = identifier
			key.PlainColumn = true
		case "ASC", "DESC":
			key.Column = identifier
			key.Direction = strings.ToUpper(remainder)
			// Ordered keys are intentionally not constraint-equivalent: preserve
			// their ordering when emitting CREATE INDEX.
			key.PlainColumn = false
		}
	}
	return key, true
}

func indexKeyDisplayNames(keys []xuguIndexKey) []string {
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		if key.PlainColumn {
			result = append(result, key.Column)
			continue
		}
		result = append(result, key.Raw)
	}
	return emptyIfNil(result)
}

func xuguIndexKeysForDDL(index indexInfo) []xuguIndexKey {
	if len(index.keys) > 0 {
		return index.keys
	}
	keys := make([]xuguIndexKey, 0, len(index.Columns))
	for _, column := range index.Columns {
		// indexInfo.Columns is the established metadata API: callers that build
		// it directly already provide decoded column names, including names that
		// contain commas or parentheses. Raw catalog keys are kept separately in
		// indexInfo.keys and parsed above.
		column = strings.TrimSpace(column)
		if column != "" {
			keys = append(keys, xuguIndexKey{Raw: column, Column: column, PlainColumn: true})
		}
	}
	return keys
}

func xuguPlainIndexColumns(index indexInfo) ([]string, bool) {
	keys := xuguIndexKeysForDDL(index)
	if len(keys) == 0 {
		return nil, false
	}
	columns := make([]string, 0, len(keys))
	for _, key := range keys {
		if !key.PlainColumn {
			return nil, false
		}
		columns = append(columns, key.Column)
	}
	return columns, true
}

func renderXuguIndexKey(key xuguIndexKey) string {
	if key.PlainColumn || key.Direction != "" {
		result := quoteIdentifier(key.Column)
		if key.Direction != "" {
			result += " " + key.Direction
		}
		return result
	}
	// Function/expression keys are already database-produced SQL. Requoting the
	// whole value would turn LOWER("CODE") or "CODE" DESC into an identifier.
	return key.Raw
}

func parseForeignKeyColumns(define string) ([]string, []string) {
	groups := xuguParenthesizedGroups(define)
	if len(groups) < 2 {
		columns := parseQuotedIdentifiers(define)
		if len(columns)%2 == 0 {
			mid := len(columns) / 2
			return columns[:mid], columns[mid:]
		}
		return columns, nil
	}
	return parseIdentifierList(groups[0]), parseIdentifierList(groups[1])
}

func parseIdentifierList(value string) []string {
	parts := splitXuguTopLevel(value, ',')
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if identifier, ok := unquoteXuguIdentifier(part); ok {
			result = append(result, identifier)
			continue
		}
		result = append(result, strings.Trim(part, `"`))
	}
	return result
}

func xuguParenthesizedGroups(value string) []string {
	var result []string
	depth, start := 0, -1
	inQuote := false
	for i := 0; i < len(value); i++ {
		if inQuote {
			if value[i] == '"' {
				if i+1 < len(value) && value[i+1] == '"' {
					i++
				} else {
					inQuote = false
				}
			}
			continue
		}
		switch value[i] {
		case '"':
			inQuote = true
		case '(':
			if depth == 0 {
				start = i + 1
			}
			depth++
		case ')':
			if depth == 0 {
				continue
			}
			depth--
			if depth == 0 && start >= 0 {
				result = append(result, value[start:i])
				start = -1
			}
		}
	}
	return result
}

func splitXuguTopLevel(value string, separator byte) []string {
	var result []string
	start, depth := 0, 0
	inQuote := false
	for i := 0; i < len(value); i++ {
		if inQuote {
			if value[i] == '"' {
				if i+1 < len(value) && value[i+1] == '"' {
					i++
				} else {
					inQuote = false
				}
			}
			continue
		}
		switch value[i] {
		case '"':
			inQuote = true
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		default:
			if value[i] == separator && depth == 0 {
				result = append(result, value[start:i])
				start = i + 1
			}
		}
	}
	result = append(result, value[start:])
	return result
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

func triggerLevelName(value any) string {
	switch fmt.Sprint(normalizeValue(value)) {
	case "1":
		return "FOR EACH ROW"
	case "2":
		return "FOR STATEMENT"
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

func errorResponse(id json.RawMessage, method, agentSessionID string, err error) response {
	return response{JSONRPC: "2.0", ID: id, Error: classifyRPCError(method, agentSessionID, err)}
}

func trimStatementSQL(sqlText string) string {
	trimmed := strings.TrimSpace(sqlText)
	if isXuguProgrammableObjectDDL(trimmed) {
		// Xugu's compiler requires the terminator after END. The desktop
		// statement splitter already removes only client-side delimiters, while
		// retaining this one for Oracle-style procedural objects.
		return trimmed
	}
	return strings.TrimRight(trimmed, "; \t\r\n")
}

func isXuguProgrammableObjectDDL(sqlText string) bool {
	fields := strings.Fields(strings.ToUpper(stripLeadingSQLComments(sqlText)))
	if len(fields) < 2 || fields[0] != "CREATE" {
		return false
	}

	// Skip CREATE modifiers used by Xugu/Oracle-style programmable DDL:
	// OR REPLACE, FORCE/NOFORCE, and EDITIONABLE/NONEDITIONABLE (any order).
	index := 1
	for index < len(fields) {
		if index+1 < len(fields) && fields[index] == "OR" && fields[index+1] == "REPLACE" {
			index += 2
			continue
		}
		switch fields[index] {
		case "FORCE", "NOFORCE", "EDITIONABLE", "NONEDITIONABLE":
			index++
			continue
		}
		break
	}
	if index >= len(fields) {
		return false
	}

	switch fields[index] {
	case "PROCEDURE", "FUNCTION", "TRIGGER", "PACKAGE":
		// PACKAGE also covers PACKAGE BODY (next token is BODY).
		return true
	case "TYPE":
		// Only TYPE BODY needs the trailing END; terminator.
		// Plain CREATE TYPE ... AS OBJECT (...); is ordinary SQL.
		return index+1 < len(fields) && fields[index+1] == "BODY"
	default:
		return false
	}
}

func stripLeadingSQLComments(sqlText string) string {
	remaining := strings.TrimLeft(sqlText, " \t\r\n")
	for {
		switch {
		case strings.HasPrefix(remaining, "--"):
			lineEnd := strings.IndexByte(remaining, '\n')
			if lineEnd < 0 {
				return ""
			}
			remaining = strings.TrimLeft(remaining[lineEnd+1:], " \t\r\n")
		case strings.HasPrefix(remaining, "/*"):
			commentEnd := strings.Index(remaining[2:], "*/")
			if commentEnd < 0 {
				return ""
			}
			remaining = strings.TrimLeft(remaining[commentEnd+4:], " \t\r\n")
		default:
			return remaining
		}
	}
}

func isQuerySQL(sqlText string) bool {
	sqlText = stripLeadingSQLComments(sqlText)
	for _, keyword := range []string{"select", "with", "show", "explain"} {
		if hasLeadingSQLKeyword(sqlText, keyword) {
			return true
		}
	}
	return false
}

func hasLeadingSQLKeyword(sqlText, keyword string) bool {
	if len(sqlText) < len(keyword) || !strings.EqualFold(sqlText[:len(keyword)], keyword) {
		return false
	}
	if len(sqlText) == len(keyword) {
		return true
	}
	next, _ := utf8.DecodeRuneInString(sqlText[len(keyword):])
	return !isSQLIdentifierContinuation(next)
}

func isSQLIdentifierContinuation(value rune) bool {
	return value == '_' || value == '$' || value == '#' || unicode.IsLetter(value) || unicode.IsDigit(value) || unicode.IsMark(value)
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
