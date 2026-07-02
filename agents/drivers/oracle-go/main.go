package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	_ "github.com/sijms/go-ora/v2"
	go_ora "github.com/sijms/go-ora/v2"
)

const protocolVersion = 1
const defaultMaxRows = 1000
const oracleListDatabasesSQL = `
SELECT username AS owner
FROM all_users
WHERE username IS NOT NULL
  AND username NOT IN (
    'SYS','SYSTEM','SYSMAN','DBSNMP','SYSBACKUP','SYSDG','SYSKM','SYSRAC','OUTLN',
    'AUDSYS','LBACSYS','DVF','DVSYS','APPQOSSYS','CTXSYS','MDSYS','MDDATA',
    'ORDSYS','ORDDATA','ORDPLUGINS','XDB','ANONYMOUS','DIP','EXFSYS',
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
const oracleListTablesSQL = `
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
)
ORDER BY OBJECT_NAME`
const oracleListObjectsSQL = `
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
       o.OBJECT_TYPE,
       CAST(NULL AS VARCHAR2(4000)) AS COMMENTS
FROM ALL_OBJECTS o
WHERE o.OWNER = :2
  AND o.OBJECT_TYPE IN ('VIEW', 'PROCEDURE', 'FUNCTION', 'PACKAGE')
)
ORDER BY CASE OBJECT_TYPE
  WHEN 'TABLE' THEN 0
  WHEN 'VIEW' THEN 1
  WHEN 'PROCEDURE' THEN 2
  WHEN 'FUNCTION' THEN 3
  ELSE 4
END, OBJECT_NAME`

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
	SQL       string `json:"sql"`
	Database  string `json:"database"`
	Schema    string `json:"schema"`
	MaxRows   int    `json:"maxRows"`
	FetchSize int    `json:"fetchSize"`
}

type queryResult struct {
	Columns         []string `json:"columns"`
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
	if value.Rows == nil {
		value.Rows = [][]any{}
	}
	return json.Marshal(value)
}

type queryPageResult struct {
	Columns         []string `json:"columns"`
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
	if value.Rows == nil {
		value.Rows = [][]any{}
	}
	return json.Marshal(value)
}

type querySession struct {
	rows      *sql.Rows
	columns   []string
	pending   []any
	remaining int
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
	Name   string `json:"name"`
	Event  string `json:"event"`
	Timing string `json:"timing"`
}

type server struct {
	db                     *sql.DB
	params                 connectParams
	sessions               map[string]*querySession
	tableReadSessions      map[string]*querySession
	nextSessionID          int64
	nextTableReadSessionID int64
}

func main() {
	s := newServer()
	encoder := json.NewEncoder(os.Stdout)
	fmt.Fprintln(os.Stdout, `{"ready":true}`)

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 512*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		resp, shutdown := s.handleLine(line)
		if err := encoder.Encode(resp); err != nil {
			fmt.Fprintf(os.Stderr, "failed to write response: %v\n", err)
			return
		}
		if shutdown {
			return
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintf(os.Stderr, "failed to read stdin: %v\n", err)
	}
}

func newServer() *server {
	return &server{sessions: map[string]*querySession{}, tableReadSessions: map[string]*querySession{}}
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
	case "list_databases":
		result, err := s.listDatabases()
		return result, false, err
	case "list_schemas":
		result, err := s.listSchemas(stringSliceParam(params, "visible_schemas"))
		return result, false, err
	case "list_tables":
		schema := stringParam(params, "schema")
		result, err := s.listTables(schema)
		return result, false, err
	case "list_objects":
		schema := stringParam(params, "schema")
		result, err := s.listObjects(schema)
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
	_ = s.disconnect()
	db, err := openDB(params)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return err
	}
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
	dsn := buildDSN(params)
	db, err := sql.Open("oracle", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(30 * time.Minute)
	return db, nil
}

func buildDSN(params connectParams) string {
	connectionString := strings.TrimSpace(params.ConnectionString)
	if strings.HasPrefix(strings.ToLower(connectionString), "oracle://") {
		return connectionString
	}
	options := parseURLParams(params.URLParams)
	if params.SysDBA {
		options["AUTH TYPE"] = "SYSDBA"
	}

	if jdbc := parseOracleJDBCURL(connectionString); jdbc.Kind != "" {
		if jdbc.Descriptor != "" {
			return go_ora.BuildJDBC(params.Username, params.Password, jdbc.Descriptor, options)
		}
		host := jdbc.Host
		port := jdbc.Port
		if port == 0 {
			port = 1521
		}
		if jdbc.Kind == "sid" {
			options["SID"] = jdbc.Database
			return go_ora.BuildUrl(host, port, "", params.Username, params.Password, options)
		}
		return go_ora.BuildUrl(host, port, jdbc.Database, params.Username, params.Password, options)
	}

	service := strings.TrimSpace(params.Database)
	if strings.HasPrefix(strings.ToUpper(service), "SYSDBA:") {
		service = strings.TrimSpace(service[len("SYSDBA:"):])
	}
	port := params.Port
	if port == 0 {
		port = 1521
	}
	return go_ora.BuildUrl(params.Host, port, service, params.Username, params.Password, options)
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
	defer rows.Close()
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
	databases, err := s.listDatabasesFiltered(visibleSchemas)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(databases))
	for _, database := range databases {
		result = append(result, database.Name)
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
	defer rows.Close()
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
	if len(visibleSchemas) == 0 {
		return oracleListDatabasesSQL, nil
	}
	placeholders := make([]string, 0, len(visibleSchemas))
	args := make([]any, 0, len(visibleSchemas))
	for i, schema := range visibleSchemas {
		placeholders = append(placeholders, fmt.Sprintf(":%d", i+1))
		args = append(args, schema)
	}
	sqlText := strings.Replace(
		oracleListDatabasesSQL,
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
	schema = strings.TrimSpace(schema)
	if schema == "" {
		return s.currentSchema()
	}
	return strings.ToUpper(schema), nil
}

func (s *server) listTables(schema string) ([]tableInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	rows, err := s.queryRows(oracleListTablesSQL, []any{schema, schema})
	if err != nil {
		if isOraclePGALimitError(err) {
			return []tableInfo{}, nil
		}
		return nil, err
	}
	defer rows.Close()
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

func (s *server) listObjects(schema string) ([]objectInfo, error) {
	schema, err := s.normalizeSchema(schema)
	if err != nil {
		return nil, err
	}
	rows, err := s.queryRows(oracleListObjectsSQL, []any{schema, schema})
	if err != nil {
		if isOraclePGALimitError(err) {
			return []objectInfo{}, nil
		}
		return nil, err
	}
	defer rows.Close()
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
	defer rows.Close()
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
	defer rows.Close()
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
	defer rows.Close()

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
	defer rows.Close()
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
	rows, err := s.queryRows(`
SELECT TRIGGER_NAME, TRIGGERING_EVENT, TRIGGER_TYPE
FROM ALL_TRIGGERS
WHERE OWNER = :1 AND TABLE_NAME = :2
ORDER BY TRIGGER_NAME`, []any{schema, table})
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []triggerInfo
	for rows.Next() {
		var item triggerInfo
		if err := rows.Scan(&item.Name, &item.Event, &item.Timing); err != nil {
			return nil, err
		}
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
	defer rows.Close()
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

func (s *server) getExplainInfo(sqlText string) (string, error) {
	if strings.TrimSpace(sqlText) == "" {
		return "", errors.New("sql is required")
	}
	rows, err := s.queryRows("EXPLAIN PLAN FOR "+trimStatementSQL(sqlText), nil)
	if err != nil {
		return "", err
	}
	rows.Close()
	planRows, err := s.queryRows("SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())", nil)
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
			Rows:            result.Rows,
			AffectedRows:    result.AffectedRows,
			ExecutionTimeMS: result.ExecutionTimeMS,
			Truncated:       result.Truncated,
			SessionID:       nil,
			HasMore:         false,
		}, err
	}
	sqlText, err := s.rewriteXMLTypeSelectSQL(sqlText)
	if err != nil {
		return queryPageResult{}, err
	}
	rows, err := s.queryRows(sqlText, nil)
	if err != nil {
		return queryPageResult{}, err
	}
	columns, err := rows.Columns()
	if err != nil {
		rows.Close()
		return queryPageResult{}, err
	}
	maxRows := opts.MaxRows
	if maxRows <= 0 {
		maxRows = defaultMaxRows
	}
	session := &querySession{rows: rows, columns: columns, remaining: maxRows}
	result, err := readQuerySessionPage(session, pageSize)
	result.ExecutionTimeMS = time.Since(start).Milliseconds()
	if err != nil {
		rows.Close()
		return queryPageResult{}, err
	}
	if result.HasMore {
		sessionID := s.storeQuerySession(session)
		result.SessionID = &sessionID
	} else {
		rows.Close()
	}
	return result, nil
}

func (s *server) fetchQueryPage(sessionID string, pageSize int) (queryPageResult, error) {
	session := s.sessions[sessionID]
	if session == nil {
		return queryPageResult{Columns: []string{}, Rows: [][]any{}, SessionID: nil, HasMore: false}, nil
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
	sqlText, err := s.rewriteXMLTypeSelectSQL(sqlText)
	if err != nil {
		return queryPageResult{}, err
	}
	rows, err := s.queryRows(sqlText, nil)
	if err != nil {
		return queryPageResult{}, err
	}
	columns, err := rows.Columns()
	if err != nil {
		rows.Close()
		return queryPageResult{}, err
	}
	maxRows := opts.MaxRows
	if maxRows <= 0 {
		maxRows = defaultMaxRows
	}
	session := &querySession{rows: rows, columns: columns, remaining: maxRows}
	result, err := readQuerySessionPage(session, pageSize)
	result.ExecutionTimeMS = time.Since(start).Milliseconds()
	if err != nil {
		rows.Close()
		return queryPageResult{}, err
	}
	if result.HasMore {
		sessionID := s.storeTableReadSession(session)
		result.SessionID = &sessionID
	} else {
		rows.Close()
	}
	return result, nil
}

func (s *server) fetchTableReadPage(sessionID string, pageSize int) (queryPageResult, error) {
	session := s.tableReadSessions[sessionID]
	if session == nil {
		return queryPageResult{Columns: []string{}, Rows: [][]any{}, SessionID: nil, HasMore: false}, nil
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
	session.rows.Close()
	delete(s.sessions, sessionID)
	return true
}

func (s *server) closeTableReadSession(sessionID string) bool {
	session := s.tableReadSessions[sessionID]
	if session == nil {
		return false
	}
	session.rows.Close()
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
	result := queryPageResult{Columns: session.columns, Rows: [][]any{}, SessionID: nil, HasMore: false}
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
		result, err := s.executeSelect(sqlText, maxRows)
		result.ExecutionTimeMS = time.Since(start).Milliseconds()
		return result, err
	}
	db, err := s.requireDB()
	if err != nil {
		return queryResult{}, err
	}
	execResult, err := db.Exec(sqlText)
	if err != nil {
		return queryResult{}, err
	}
	affected, _ := execResult.RowsAffected()
	return queryResult{Columns: []string{}, Rows: [][]any{}, AffectedRows: affected, ExecutionTimeMS: time.Since(start).Milliseconds()}, nil
}

func (s *server) executeSelect(sqlText string, maxRows int) (queryResult, error) {
	var err error
	sqlText, err = s.rewriteXMLTypeSelectSQL(sqlText)
	if err != nil {
		return queryResult{}, err
	}
	rows, err := s.queryRows(sqlText, nil)
	if err != nil {
		return queryResult{}, err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return queryResult{}, err
	}
	result := queryResult{Columns: columns, Rows: [][]any{}}
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
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}
	if len(args) == 0 {
		return db.Query(sqlText)
	}
	return db.Query(sqlText, args...)
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
	return strings.TrimRight(strings.TrimSpace(sqlText), "; \t\r\n")
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

func normalizeValue(value any) any {
	switch v := value.(type) {
	case nil:
		return nil
	case []byte:
		return string(v)
	case time.Time:
		return v.Format(time.RFC3339Nano)
	case int64, float64, bool, string:
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
