package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestHandshakeResponse(t *testing.T) {
	s := newServer()
	resp, shutdown := s.handleLine(`{"jsonrpc":"2.0","id":7,"method":"handshake","params":{"appVersion":"dev"}}`)
	if shutdown {
		t.Fatal("handshake should not shut down the server")
	}
	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
	data, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		ProtocolVersion      int      `json:"protocolVersion"`
		AgentProtocolVersion int      `json:"agentProtocolVersion"`
		Capabilities         []string `json:"capabilities"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	if result.ProtocolVersion != 1 || result.AgentProtocolVersion != 1 {
		t.Fatalf("unexpected protocol versions: %+v", result)
	}
	contract := protocolContract(t)
	if result.ProtocolVersion != contract.ProtocolVersion || result.AgentProtocolVersion != contract.ProtocolVersion {
		t.Fatalf("handshake protocol versions do not match contract: result=%+v contract=%+v", result, contract)
	}
	for _, capability := range result.Capabilities {
		if !contains(contract.AllCapabilities, capability) {
			t.Fatalf("handshake returned capability %q outside protocol contract %v", capability, contract.AllCapabilities)
		}
	}
	if !contains(result.Capabilities, "query") || !contains(result.Capabilities, "metadata") {
		t.Fatalf("expected query and metadata capabilities, got %v", result.Capabilities)
	}
}

func TestRuntimeHandshakeAdvertisesMultiSessionProtocol(t *testing.T) {
	runtime := newRuntimeServer()
	resp, shutdown := runtime.handleLine(`{"jsonrpc":"2.0","id":7,"method":"handshake","params":{}}`)
	if shutdown || resp.Error != nil {
		t.Fatalf("unexpected handshake response: shutdown=%v error=%v", shutdown, resp.Error)
	}
	data, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		ProtocolVersion int      `json:"protocolVersion"`
		Capabilities    []string `json:"capabilities"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	if result.ProtocolVersion != multiSessionProtocolVersion || !contains(result.Capabilities, "multi_session") {
		t.Fatalf("unexpected runtime handshake: %+v", result)
	}
}

func TestRuntimeMissingAgentSessionDoesNotUseQueryCursorSessionID(t *testing.T) {
	runtime := newRuntimeServer()
	resp, shutdown := runtime.handleLine(`{"jsonrpc":"2.0","id":8,"method":"fetch_query_page","params":{"sessionId":"cursor-1"}}`)
	if shutdown {
		t.Fatal("fetch_query_page should not shut down the runtime")
	}
	if resp.Error == nil || !strings.Contains(resp.Error.Message, legacyAgentSessionID) {
		t.Fatalf("expected missing legacy agent session error, got %#v", resp.Error)
	}
}

func TestRuntimeCloseOneSessionKeepsOtherSessionRegistered(t *testing.T) {
	runtime := newRuntimeServer()
	runtime.sessions["a"] = &agentSession{server: newServer()}
	runtime.sessions["b"] = &agentSession{server: newServer()}

	if err := runtime.closeSession("a"); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.session("a"); err == nil {
		t.Fatal("closed session should be removed")
	}
	if _, err := runtime.session("b"); err != nil {
		t.Fatalf("other session should remain registered: %v", err)
	}
}

func TestRuntimeCancelSessionOnlyCancelsTargetSession(t *testing.T) {
	runtime := newRuntimeServer()
	serverA := newServer()
	serverB := newServer()
	ctxA, cancelA := context.WithCancel(context.Background())
	ctxB, cancelB := context.WithCancel(context.Background())
	serverA.activeCancel = cancelA
	serverB.activeCancel = cancelB
	runtime.sessions["a"] = &agentSession{server: serverA}
	runtime.sessions["b"] = &agentSession{server: serverB}

	resp, shutdown := runtime.handleLine(`{"jsonrpc":"2.0","id":9,"method":"cancel_session","params":{"agentSessionId":"a"}}`)
	if shutdown || resp.Error != nil {
		t.Fatalf("unexpected cancel response: shutdown=%v error=%v", shutdown, resp.Error)
	}
	select {
	case <-ctxA.Done():
	default:
		t.Fatal("target session was not canceled")
	}
	select {
	case <-ctxB.Done():
		t.Fatal("canceling session a should not cancel session b")
	default:
	}
	cancelB()
}

func TestRuntimeRejectsSessionsBeyondLimit(t *testing.T) {
	runtime := newRuntimeServer()
	for index := 0; index < maxAgentSessions; index++ {
		runtime.sessions[fmt.Sprintf("session-%d", index)] = &agentSession{server: newServer()}
	}
	err := runtime.openSession("overflow", connectParams{})
	if err == nil || !strings.Contains(err.Error(), "session limit") {
		t.Fatalf("expected session limit error, got %v", err)
	}
}

func TestNewXuguDatabaseSessionFindsOnlyNewSession(t *testing.T) {
	existing := xuguDatabaseSession{nodeID: 1, sessionID: 10}
	created := xuguDatabaseSession{nodeID: 1, sessionID: 11}
	result, err := newXuguDatabaseSession(
		map[xuguDatabaseSession]struct{}{existing: {}},
		map[xuguDatabaseSession]struct{}{existing: {}, created: {}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result != created {
		t.Fatalf("unexpected session: %+v", result)
	}
}

func TestXuguSessionAppNameIsStableAndDoesNotExposeSessionID(t *testing.T) {
	name := xuguSessionAppName("tab-session-secret")
	if name != xuguSessionAppName("tab-session-secret") {
		t.Fatal("app name should be stable")
	}
	if strings.Contains(name, "tab-session-secret") || !strings.HasPrefix(name, "DBX_") {
		t.Fatalf("unexpected app name: %s", name)
	}
}

func TestCloseMissingQuerySessionReturnsFalse(t *testing.T) {
	s := newServer()
	resp, shutdown := s.handleLine(`{"jsonrpc":"2.0","id":8,"method":"close_query_session","params":{"sessionId":"missing"}}`)
	if shutdown {
		t.Fatal("close_query_session should not shut down the server")
	}
	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
	if resp.Result != false {
		t.Fatalf("expected false result, got %#v", resp.Result)
	}
}

func TestListDataTypesReturnsXuguTypes(t *testing.T) {
	s := newServer()
	resp, shutdown := s.handleLine(`{"jsonrpc":"2.0","id":9,"method":"list_data_types","params":{"database":"demo"}}`)
	if shutdown {
		t.Fatal("list_data_types should not shut down the server")
	}
	if resp.Error != nil {
		t.Fatalf("unexpected error: %v", resp.Error)
	}
	data, err := json.Marshal(resp.Result)
	if err != nil {
		t.Fatal(err)
	}
	var result []string
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"INTEGER", "VARCHAR", "NUMERIC", "INT"} {
		if !contains(result, want) {
			t.Fatalf("expected data type %q in %v", want, result)
		}
	}
}

func TestEmptyResultSlicesMarshalAsArrays(t *testing.T) {
	data, err := json.Marshal(queryResult{})
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, `"columns":null`) || strings.Contains(text, `"column_types":null`) || strings.Contains(text, `"rows":null`) {
		t.Fatalf("query result should marshal nil slices as arrays: %s", text)
	}

	data, err = json.Marshal(indexInfo{})
	if err != nil {
		t.Fatal(err)
	}
	text = string(data)
	if strings.Contains(text, `"columns":null`) || strings.Contains(text, `"included_columns":null`) {
		t.Fatalf("index info should marshal nil slices as arrays: %s", text)
	}
}

func TestGetTableDDLResultMarshalsAsString(t *testing.T) {
	data, err := json.Marshal("CREATE TABLE SYSDBA.ORDERS (ID INT)")
	if err != nil {
		t.Fatal(err)
	}
	var ddl string
	if err := json.Unmarshal(data, &ddl); err != nil {
		t.Fatalf("get_table_ddl result must deserialize as a string: %v", err)
	}
}

func TestBuildDSNUsesConnectionStringWhenProvided(t *testing.T) {
	dsn := buildDSN(connectParams{ConnectionString: "IP=db.example.com;DB=SYSTEM;User=SYSDBA;PWD=secret;Port=5138"})

	if dsn != "IP=db.example.com;DB=SYSTEM;User=SYSDBA;PWD=secret;Port=5138" {
		t.Fatalf("unexpected dsn: %s", dsn)
	}
}

func protocolContract(t *testing.T) struct {
	ProtocolVersion int      `json:"protocolVersion"`
	AllCapabilities []string `json:"allCapabilities"`
} {
	t.Helper()
	data, err := os.ReadFile("../../common/src/main/resources/agent-protocol-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		ProtocolVersion int      `json:"protocolVersion"`
		AllCapabilities []string `json:"allCapabilities"`
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	return contract
}

func TestBuildDSNUsesConnectionFields(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:     "db.example.com",
		Port:     15138,
		Database: "demo",
		Username: "sysdba",
		Password: "secret",
	})

	for _, part := range []string{"IP=db.example.com", "DB=demo", "User=sysdba", "PWD=secret", "Port=15138"} {
		if !strings.Contains(dsn, part) {
			t.Fatalf("dsn should contain %s, got: %s", part, dsn)
		}
	}
}

func TestBuildDSNUsesDefaultPort(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:     "db.example.com",
		Database: "demo",
		Username: "sysdba",
		Password: "secret",
	})

	if !strings.Contains(dsn, "Port=5138") {
		t.Fatalf("dsn should default to Xugu port, got: %s", dsn)
	}
}

func TestBuildDSNParsesJdbcURL(t *testing.T) {
	dsn := buildDSN(connectParams{
		Username:         "sysdba",
		Password:         "secret",
		ConnectionString: "jdbc:xugu://db.example.com:15138/demo",
	})

	for _, part := range []string{"IP=db.example.com", "DB=demo", "User=sysdba", "PWD=secret", "Port=15138"} {
		if !strings.Contains(dsn, part) {
			t.Fatalf("dsn should contain %s, got: %s", part, dsn)
		}
	}
}

func TestBuildDSNParsesDBXURL(t *testing.T) {
	dsn := buildDSN(connectParams{
		ConnectionString: "xugu://sysdba:secret@db.example.com:15138/demo",
	})

	for _, part := range []string{"IP=db.example.com", "DB=demo", "User=sysdba", "PWD=secret", "Port=15138"} {
		if !strings.Contains(dsn, part) {
			t.Fatalf("dsn should contain %s, got: %s", part, dsn)
		}
	}
}

func TestBuildDSNAppendsURLParams(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:      "db.example.com",
		Database:  "demo",
		Username:  "sysdba",
		Password:  "secret",
		URLParams: "AUTO_COMMIT=on;CHAR_SET=UTF8",
	})

	for _, part := range []string{"AUTO_COMMIT=on", "CHAR_SET=UTF8"} {
		if !strings.Contains(dsn, part) {
			t.Fatalf("dsn should contain %s, got: %s", part, dsn)
		}
	}
}

func TestBuildDSNDefaultsToUTF8(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:     "db.example.com",
		Database: "demo",
		Username: "sysdba",
		Password: "secret",
	})

	if !strings.Contains(dsn, "CHAR_SET=UTF8") {
		t.Fatalf("dsn should default to UTF8, got: %s", dsn)
	}
}

func TestBuildDSNRespectsExplicitCharset(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:      "db.example.com",
		Database:  "demo",
		Username:  "sysdba",
		Password:  "secret",
		URLParams: "CHAR_SET=GBK",
	})

	if strings.Contains(dsn, "CHAR_SET=UTF8") || !strings.Contains(dsn, "CHAR_SET=GBK") {
		t.Fatalf("dsn should respect explicit charset, got: %s", dsn)
	}
}

func TestListDatabasesSQLUsesXuguDictionary(t *testing.T) {
	sqlText := strings.ToUpper(xuguListDatabasesSQL)

	if !strings.Contains(sqlText, "ALL_DATABASES") || strings.Contains(sqlText, "SYS_DATABASES") {
		t.Fatalf("database listing should query low-privilege ALL_DATABASES, got: %s", xuguListDatabasesSQL)
	}
}

func TestFallbackDatabasesFromParams(t *testing.T) {
	cases := []struct {
		name   string
		params connectParams
		want   string
	}{
		{
			name: "database field",
			params: connectParams{
				Database: "LOWPRIV",
			},
			want: "LOWPRIV",
		},
		{
			name: "dbx url",
			params: connectParams{
				ConnectionString: "xugu://user:secret@db.example.com:5138/demo",
			},
			want: "demo",
		},
		{
			name: "jdbc url",
			params: connectParams{
				ConnectionString: "jdbc:xugu://db.example.com:5138/reporting",
			},
			want: "reporting",
		},
		{
			name: "native dsn",
			params: connectParams{
				ConnectionString: "IP=db.example.com;DB=SYSTEM;User=SYSDBA;PWD=secret;Port=5138",
			},
			want: "SYSTEM",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := fallbackDatabasesFromParams(tc.params)
			if len(got) != 1 || got[0].Name != tc.want {
				t.Fatalf("unexpected fallback databases: got=%v want=%s", got, tc.want)
			}
		})
	}
}

func TestUseDatabaseSkipsConfiguredDatabase(t *testing.T) {
	s := newServer()
	s.params = connectParams{Database: "SYSTEM"}

	if err := s.useDatabase("system"); err != nil {
		t.Fatalf("expected configured database USE to be skipped, got: %v", err)
	}
}

func TestConfiguredDatabaseName(t *testing.T) {
	cases := []struct {
		params connectParams
		want   string
	}{
		{params: connectParams{Database: "SYSTEM"}, want: "SYSTEM"},
		{params: connectParams{ConnectionString: "xugu://user:secret@db.example.com:5138/demo"}, want: "demo"},
		{params: connectParams{ConnectionString: "jdbc:xugu://db.example.com:5138/reporting"}, want: "reporting"},
		{params: connectParams{ConnectionString: "IP=db.example.com;DB=SYSTEM;User=SYSDBA;PWD=secret"}, want: "SYSTEM"},
	}

	for _, tc := range cases {
		if got := configuredDatabaseName(tc.params); got != tc.want {
			t.Fatalf("configuredDatabaseName(%+v) = %q, want %q", tc.params, got, tc.want)
		}
	}
}

func TestSchemaListingSQLUsesLowPrivilegeDictionary(t *testing.T) {
	sqlText := strings.ToUpper(xuguListSchemasSQL)

	if !strings.Contains(sqlText, "ALL_SCHEMAS") || strings.Contains(sqlText, "SYS_SCHEMAS") {
		t.Fatalf("schema listing should query low-privilege ALL_SCHEMAS, got: %s", xuguListSchemasSQL)
	}
}

func TestPrimaryKeySQLUsesLowPrivilegeDictionary(t *testing.T) {
	sqlText := strings.ToUpper(xuguPrimaryKeyColumnsSQL)

	for _, want := range []string{"ALL_CONSTRAINTS", "ALL_TABLES", "ALL_SCHEMAS"} {
		if !strings.Contains(sqlText, want) {
			t.Fatalf("primary key listing should query %s, got: %s", want, xuguPrimaryKeyColumnsSQL)
		}
	}
	for _, forbidden := range []string{"SYS_CONSTRAINTS", "SYS_TABLES", "SYS_SCHEMAS"} {
		if strings.Contains(sqlText, forbidden) {
			t.Fatalf("primary key listing should not query %s, got: %s", forbidden, xuguPrimaryKeyColumnsSQL)
		}
	}
}

func TestColumnSQLUsesLowPrivilegeDictionary(t *testing.T) {
	sqlText := strings.ToUpper(xuguListColumnsSQL)

	for _, want := range []string{"ALL_COLUMNS", "ALL_TABLES", "ALL_SCHEMAS", "COMMENTS", `"VARYING"`} {
		if !strings.Contains(sqlText, want) {
			t.Fatalf("column listing should query %s, got: %s", want, xuguListColumnsSQL)
		}
	}
	for _, forbidden := range []string{"SYS_COLUMNS", "SYS_TABLES", "SYS_SCHEMAS"} {
		if strings.Contains(sqlText, forbidden) {
			t.Fatalf("column listing should not query %s, got: %s", forbidden, xuguListColumnsSQL)
		}
	}
}

func TestLegacyColumnSQLSupportsServersWithoutOnNullMetadata(t *testing.T) {
	sqlText := strings.ToUpper(xuguLegacyListColumnsSQL)

	for _, want := range []string{"ALL_COLUMNS", "ALL_TABLES", "ALL_SCHEMAS", "COMMENTS", `"VARYING"`} {
		if !strings.Contains(sqlText, want) {
			t.Fatalf("legacy column listing should query %s, got: %s", want, xuguLegacyListColumnsSQL)
		}
	}
	if strings.Contains(sqlText, "ON_NULL") {
		t.Fatalf("legacy column listing should not require ON_NULL, got: %s", xuguLegacyListColumnsSQL)
	}
}

func TestXuguMissingOnNullColumnErrorDetection(t *testing.T) {
	if !isXuguMissingOnNullColumnError(errors.New("[E10049 L2 C57] 字段变量或函数\"C\".\"ON_NULL\"不存在\x00")) {
		t.Fatal("expected the Xugu 12.0 missing ON_NULL error to use the legacy column query")
	}
	if !isXuguMissingOnNullColumnError(errors.New(`column C.ON_NULL does not exist`)) {
		t.Fatal("expected an English missing ON_NULL error to use the legacy column query")
	}
	for _, err := range []error{
		errors.New("network timeout"),
		errors.New("column C.OTHER_COLUMN does not exist"),
		errors.New("permission denied for C.ON_NULL"),
	} {
		if isXuguMissingOnNullColumnError(err) {
			t.Fatalf("unexpected legacy column fallback for %q", err)
		}
	}
}

func TestGetColumnsFallsBackWhenOnNullMetadataIsUnavailable(t *testing.T) {
	db, err := sql.Open("xugu-test-legacy-columns", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	s := newServer()
	s.db = db
	columns, err := s.getColumns("SYSDBA", "PRODUCTS")
	if err != nil {
		t.Fatal(err)
	}
	if len(columns) != 1 {
		t.Fatalf("expected one legacy column, got %#v", columns)
	}
	column := columns[0]
	if column.Name != "PRODUCT_ID" || column.DataType != "INTEGER" || !column.IsPrimaryKey || column.IsNullable {
		t.Fatalf("unexpected legacy column metadata: %#v", column)
	}
}

func TestIndexSQLUsesLowPrivilegeDictionary(t *testing.T) {
	sqlText := strings.ToUpper(xuguListIndexesSQL)

	for _, want := range []string{"ALL_INDEXES", "ALL_TABLES", "ALL_SCHEMAS", "KEYS"} {
		if !strings.Contains(sqlText, want) {
			t.Fatalf("index listing should query %s, got: %s", want, xuguListIndexesSQL)
		}
	}
	for _, forbidden := range []string{"SYS_INDEXES", "SYS_TABLES", "SYS_SCHEMAS"} {
		if strings.Contains(sqlText, forbidden) {
			t.Fatalf("index listing should not query %s, got: %s", forbidden, xuguListIndexesSQL)
		}
	}
}

func TestXuguMetadataAccessErrorDetection(t *testing.T) {
	if !isXuguMetadataAccessError(errors.New("[E18012] 权限不够")) {
		t.Fatal("expected E18012 permission error to be treated as metadata access error")
	}
	if isXuguMetadataAccessError(errors.New("network timeout")) {
		t.Fatal("network errors should not trigger database-list fallback")
	}
}

func TestXuguListTablesQueryAppliesMetadataConstraints(t *testing.T) {
	query := xuguListTablesQuery("APP", metadataListConstraints{
		Filter:      "ord_",
		ObjectTypes: []string{"view", "table", "VIEW"},
		Limit:       25,
		Offset:      50,
	})

	for _, want := range []string{
		"UPPER(TABLE_NAME) LIKE ? ESCAPE '\\'",
		"TABLE_TYPE IN (?,?)",
		"ORDER BY TABLE_TYPE, TABLE_NAME",
		"ROWNUM <= ?",
		"DBX_RN > ?",
	} {
		if !strings.Contains(query.SQL, want) {
			t.Fatalf("expected SQL to contain %q:\n%s", want, query.SQL)
		}
	}

	wantArgs := []any{"APP", "APP", `%O%R%D%\_%`, "TABLE", "VIEW", 75, 50}
	assertArgs(t, query.Args, wantArgs)
}

func TestXuguListObjectsQueryRejectsUnsupportedObjectTypes(t *testing.T) {
	query := xuguListObjectsQuery("APP", metadataListConstraints{
		ObjectTypes: []string{"INDEX"},
		Limit:       10,
	})

	if !strings.Contains(query.SQL, "1 = 0") {
		t.Fatalf("unsupported object type should produce empty-result predicate:\n%s", query.SQL)
	}

	wantArgs := []any{"APP", "APP", "APP", "APP", "APP", "APP", "APP", "APP", "APP", 10, 0}
	assertArgs(t, query.Args, wantArgs)
}

func TestXuguListObjectsQueryIncludesProgrammableObjects(t *testing.T) {
	query := xuguListObjectsQuery("APP", metadataListConstraints{
		ObjectTypes: []string{"procedure", "function", "package", "package-body", "trigger", "sequence", "type", "type-body"},
	})

	for _, want := range []string{"ALL_PROCEDURES", "p.VALID", "ALL_PACKAGES", "p.BODY IS NOT NULL", "ALL_TRIGGERS", "ALL_SEQUENCES", "ALL_TYPES", "u.BODY IS NOT NULL", "OBJECT_NAME, OBJECT_TYPE, COMMENTS, VALID", "OBJECT_TYPE IN (?,?,?,?,?,?,?,?)"} {
		if !strings.Contains(query.SQL, want) {
			t.Fatalf("expected SQL to contain %q:\n%s", want, query.SQL)
		}
	}

	wantArgs := []any{"APP", "APP", "APP", "APP", "APP", "APP", "APP", "APP", "APP", "FUNCTION", "PACKAGE", "PACKAGE_BODY", "PROCEDURE", "SEQUENCE", "TRIGGER", "TYPE", "TYPE_BODY"}
	assertArgs(t, query.Args, wantArgs)
}

func TestXuguObjectSourceQuerySupportsSharedObjectKinds(t *testing.T) {
	for _, objectType := range []string{"TRIGGER", "PACKAGE_BODY", "TYPE", "TYPE_BODY"} {
		query, _, err := objectSourceQuery("APP", "demo", objectType)
		if err != nil {
			t.Fatalf("%s should support object source lookup: %v", objectType, err)
		}
		if strings.TrimSpace(query) == "" {
			t.Fatalf("%s should produce source SQL", objectType)
		}
	}

	packageBodyQuery, _, err := objectSourceQuery("APP", "demo", "PACKAGE_BODY")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(packageBodyQuery, "TO_CHAR(k.BODY)") || strings.Contains(packageBodyQuery, "k.SPEC") {
		t.Fatalf("package body query must request only the body: %s", packageBodyQuery)
	}

	typeSpecQuery, _, err := objectSourceQuery("APP", "demo", "TYPE")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(typeSpecQuery, "ALL_TYPES") || !strings.Contains(typeSpecQuery, "TO_CHAR(u.SPEC)") {
		t.Fatalf("type query must return catalog SPEC content: %s", typeSpecQuery)
	}

	typeBodyQuery, _, err := objectSourceQuery("APP", "demo", "TYPE_BODY")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(typeBodyQuery, "ALL_TYPES") || !strings.Contains(typeBodyQuery, "TO_CHAR(u.BODY)") || !strings.Contains(typeBodyQuery, "u.BODY IS NOT NULL") {
		t.Fatalf("type body query must return catalog BODY content: %s", typeBodyQuery)
	}

	for _, objectType := range []string{"VIEW", "TRIGGER", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY"} {
		query, _, err := objectSourceQuery("APP", "demo", objectType)
		if err != nil {
			t.Fatalf("%s source query: %v", objectType, err)
		}
		if !strings.Contains(query, "FROM ALL_") || !strings.Contains(query, "JOIN ALL_SCHEMAS") {
			t.Fatalf("%s must use access-scoped ALL_* metadata: %s", objectType, query)
		}
		if strings.Contains(query, "SYS_") {
			t.Fatalf("%s must not require SYS_* metadata access: %s", objectType, query)
		}
	}
}

func TestMetadataListConstraintsFromParams(t *testing.T) {
	params := map[string]json.RawMessage{
		"filter":       json.RawMessage(`"tab"`),
		"limit":        json.RawMessage(`30`),
		"offset":       json.RawMessage(`5`),
		"object_types": json.RawMessage(`["TABLE","VIEW"]`),
	}

	constraints := metadataListConstraintsFromParams(params)
	if constraints.Filter != "tab" || constraints.Limit != 30 || constraints.Offset != 5 {
		t.Fatalf("unexpected constraints: %+v", constraints)
	}
	if len(constraints.ObjectTypes) != 2 || constraints.ObjectTypes[0] != "TABLE" || constraints.ObjectTypes[1] != "VIEW" {
		t.Fatalf("unexpected object types: %+v", constraints.ObjectTypes)
	}
}

func assertArgs(t *testing.T, got []any, want []any) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("args length = %d, want %d: got=%#v want=%#v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("arg %d = %#v, want %#v; args=%#v", i, got[i], want[i], got)
		}
	}
}

func TestParseForeignKeyColumns(t *testing.T) {
	local, ref := parseForeignKeyColumns(`("C1","C2")("ID1","ID2")`)

	if strings.Join(local, ",") != "C1,C2" || strings.Join(ref, ",") != "ID1,ID2" {
		t.Fatalf("unexpected foreign key columns: local=%v ref=%v", local, ref)
	}
}

func TestRenderXuguTableDDLPreservesProgrammableTableMetadata(t *testing.T) {
	amountDefault := "0"
	description := "child table"
	ddl := renderXuguTableDDL(
		"APP", "CHILD",
		[]columnInfo{
			{Name: "ID", DataType: "INTEGER", IsNullable: false},
			{Name: "PARENT_ID", DataType: "INTEGER", IsNullable: false},
			{Name: "AMOUNT", DataType: "NUMERIC", IsNullable: true, ColumnDefault: &amountDefault},
		},
		xuguTableMetadata{
			PctFree:        15,
			CopyNum:        3,
			PartitionType:  1,
			PartitionKey:   `"ID"`,
			PartitionCount: 2,
			Comment:        description,
		},
		map[string]xuguIdentityInfo{"ID": {Column: "ID", Start: 10, Step: 5}},
		[]xuguConstraintInfo{
			{Name: "PK_CHILD", Type: "P", Definition: `"ID"`, Enabled: true},
			{Name: "CK_CHILD_AMOUNT", Type: "C", Definition: `("AMOUNT") >= (0)`, Enabled: true},
			{
				Name: "FK_CHILD_PARENT", Type: "F", Definition: `("PARENT_ID")("ID")`,
				ReferenceSchema: "APP", ReferenceTable: "PARENT", UpdateAction: "n", DeleteAction: "c", Enabled: true,
			},
		},
		[]xuguPartitionInfo{{Name: "P_10", Value: "10"}, {Name: "P_MAX", Value: "MAXVALUES"}}, nil,
	)

	for _, want := range []string{
		`"ID" INTEGER IDENTITY(10,5) NOT NULL`,
		`CONSTRAINT "PK_CHILD" PRIMARY KEY ("ID")`,
		`CONSTRAINT "CK_CHILD_AMOUNT" CHECK (("AMOUNT") >= (0))`,
		`CONSTRAINT "FK_CHILD_PARENT" FOREIGN KEY ("PARENT_ID") REFERENCES "APP"."PARENT" ("ID") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE`,
		"PCTFREE 15 COPY NUMBER 3",
		`PARTITION BY RANGE ("ID") PARTITIONS (`,
		`"P_10" VALUES LESS THAN (10)`,
		`"P_MAX" VALUES LESS THAN (MAXVALUES)`,
		"COMMENT 'child table'",
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("generated DDL is missing %q:\n%s", want, ddl)
		}
	}
}

func TestRenderXuguTableDDLTemporaryTableCommitMode(t *testing.T) {
	ddl := renderXuguTableDDL("APP", "TMP", []columnInfo{{Name: "ID", DataType: "INTEGER", IsNullable: true}},
		xuguTableMetadata{TempType: 1, OnCommitDelete: true}, nil, nil, nil, nil)
	if !strings.HasPrefix(ddl, `CREATE TEMP TABLE "APP"."TMP"`) || !strings.Contains(ddl, "ON COMMIT DELETE ROWS") {
		t.Fatalf("unexpected temporary table DDL: %s", ddl)
	}
	globalDDL := renderXuguTableDDL("APP", "GTMP", []columnInfo{{Name: "ID", DataType: "INTEGER", IsNullable: true}},
		xuguTableMetadata{TempType: 2, OnCommitDelete: false}, nil, nil, nil, nil)
	if !strings.HasPrefix(globalDDL, `CREATE GLOBAL TEMP TABLE "APP"."GTMP"`) || !strings.Contains(globalDDL, "ON COMMIT PRESERVE ROWS") {
		t.Fatalf("unexpected global temporary table DDL: %s", globalDDL)
	}
}

func TestRenderXuguTableDDLSubpartitionDefinitions(t *testing.T) {
	ddl := renderXuguTableDDL("APP", "SUBPART", []columnInfo{{Name: "ID", DataType: "INTEGER", IsNullable: true}},
		xuguTableMetadata{PartitionType: 2, PartitionKey: `"REGION"`, SubpartitionType: 1, SubpartitionKey: `"ID"`}, nil, nil,
		[]xuguPartitionInfo{{Name: "P_EAST", Value: "'east'"}},
		[]xuguPartitionInfo{{Name: "SP_10", Value: "10"}, {Name: "SP_MAX", Value: "MAXVALUES"}})
	for _, want := range []string{
		`PARTITION BY LIST ("REGION")`,
		`"P_EAST" VALUES ('east')`,
		`SUBPARTITION BY RANGE ("ID") SUBPARTITIONS (`,
		`"SP_10" VALUES LESS THAN (10)`,
		`"SP_MAX" VALUES LESS THAN (MAXVALUES)`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("generated DDL is missing %q:\n%s", want, ddl)
		}
	}
}

func TestRenderXuguTableDDLPreservesHashPartitionCount(t *testing.T) {
	ddl := renderXuguTableDDL("APP", "HASH_PART", []columnInfo{{Name: "ID", DataType: "INTEGER", IsNullable: true}},
		xuguTableMetadata{PartitionType: 3, PartitionKey: `"ID"`, PartitionCount: 4}, nil, nil,
		[]xuguPartitionInfo{{Name: "SYS_P1", Value: "1"}, {Name: "SYS_P2", Value: "2"}}, nil)
	if !strings.Contains(ddl, `PARTITION BY HASH ("ID") PARTITIONS 4`) {
		t.Fatalf("hash partition count was not preserved: %s", ddl)
	}
	if strings.Contains(ddl, "VALUES") {
		t.Fatalf("hash partition DDL must not render RANGE/LIST values: %s", ddl)
	}
}

func TestRenderXuguTableDDLPreservesMatchAndDefaultOnNull(t *testing.T) {
	insertOnlyDefault := "'insert'"
	insertUpdateDefault := "'update'"
	ddl := renderXuguTableDDL("APP", "CHILD",
		[]columnInfo{
			{Name: "A", DataType: "INTEGER", IsNullable: false},
			{Name: "B", DataType: "INTEGER", IsNullable: false},
			{Name: "INSERT_ONLY", DataType: "VARCHAR", IsNullable: false, ColumnDefault: &insertOnlyDefault, DefaultOnNull: 1},
			{Name: "INSERT_UPDATE", DataType: "VARCHAR", IsNullable: false, ColumnDefault: &insertUpdateDefault, DefaultOnNull: 2},
		},
		xuguTableMetadata{}, nil,
		[]xuguConstraintInfo{{
			Name: "FK_CHILD_PARENT", Type: "F", Definition: `("A","B")("A","B")`,
			ReferenceSchema: "APP", ReferenceTable: "PARENT", MatchType: "A", Enabled: true,
		}}, nil, nil)
	for _, want := range []string{
		`DEFAULT ON NULL FOR INSERT ONLY 'insert'`,
		`DEFAULT ON NULL FOR INSERT AND UPDATE 'update'`,
		`FOREIGN KEY ("A", "B") REFERENCES "APP"."PARENT" ("A", "B") MATCH FULL`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("generated DDL is missing %q:\n%s", want, ddl)
		}
	}
	if got := xuguMatchClause("U"); got != "" {
		t.Fatalf("MATCH_TYPE U = %q, want omitted default MATCH SIMPLE", got)
	}
}

func TestDecodeXuguScale(t *testing.T) {
	numericScale := 32*65536 + 6
	precision, scale, length := decodeXuguScale("NUMERIC", &numericScale)
	if precision == nil || *precision != 32 || scale == nil || *scale != 6 || length != nil {
		t.Fatalf("unexpected numeric scale decode: precision=%v scale=%v length=%v", precision, scale, length)
	}

	charScale := 128
	precision, scale, length = decodeXuguScale("VARCHAR", &charScale)
	if precision != nil || scale != nil || length == nil || *length != 128 {
		t.Fatalf("unexpected char scale decode: precision=%v scale=%v length=%v", precision, scale, length)
	}
}

func TestNormalizeXuguColumnTypeUsesVaryingFlag(t *testing.T) {
	tests := []struct {
		name     string
		dataType string
		varying  any
		want     string
	}{
		{name: "varying char", dataType: "CHAR", varying: true, want: "VARCHAR"},
		{name: "fixed char", dataType: "CHAR", varying: false, want: "CHAR"},
		{name: "varying binary", dataType: "BINARY", varying: true, want: "VARBINARY"},
		{name: "fixed binary", dataType: "BINARY", varying: false, want: "BINARY"},
		{name: "other varying type", dataType: "NUMERIC", varying: true, want: "NUMERIC"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeXuguColumnType(tt.dataType, tt.varying); got != tt.want {
				t.Fatalf("normalizeXuguColumnType(%q, %v) = %q, want %q", tt.dataType, tt.varying, got, tt.want)
			}
		})
	}
}

func TestAppendDDLStatement(t *testing.T) {
	got := appendDDLStatement("CREATE TABLE \"T\" (\"ID\" INT)\n", "CREATE INDEX \"IDX\" ON \"T\"(\"ID\");")
	want := "CREATE TABLE \"T\" (\"ID\" INT);\n\nCREATE INDEX \"IDX\" ON \"T\"(\"ID\");"

	if got != want {
		t.Fatalf("unexpected DDL append:\ngot:  %q\nwant: %q", got, want)
	}
}

func TestQuoteStringLiteralEscapesSingleQuotes(t *testing.T) {
	if got := quoteStringLiteral("owner's note"); got != "'owner''s note'" {
		t.Fatalf("unexpected quoted string: %s", got)
	}
}

func TestNormalizeValuePreservesDriverNumericTypes(t *testing.T) {
	if value := normalizeValue(int32(7)); value != int64(7) {
		t.Fatalf("expected int32 to normalize to int64, got %#v", value)
	}
	if value := normalizeValue(float32(1.25)); value != float64(float32(1.25)) {
		t.Fatalf("expected float32 to normalize to float64, got %#v", value)
	}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// -- fake drivers for agent tests --

func init() {
	sql.Register("xugu-test-blocking", &xuguBlockingDriver{})
	sql.Register("xugu-test-fast", &xuguFastDriver{})
	sql.Register("xugu-test-legacy-columns", &xuguLegacyColumnsDriver{})
}

type xuguLegacyColumnsDriver struct{}

func (d *xuguLegacyColumnsDriver) Open(name string) (driver.Conn, error) {
	return &xuguLegacyColumnsConn{}, nil
}

type xuguLegacyColumnsConn struct{}

func (c *xuguLegacyColumnsConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("not supported")
}
func (c *xuguLegacyColumnsConn) Close() error              { return nil }
func (c *xuguLegacyColumnsConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }
func (c *xuguLegacyColumnsConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	upper := strings.ToUpper(query)
	switch {
	case strings.Contains(upper, "ALL_CONSTRAINTS"):
		return &xuguStaticRows{columns: []string{"DEFINE"}, values: [][]driver.Value{{`PRIMARY KEY ("PRODUCT_ID")`}}}, nil
	case strings.Contains(upper, "ON_NULL"):
		return nil, errors.New("[E10049 L2 C57] 字段变量或函数\"C\".\"ON_NULL\"不存在\x00")
	case strings.Contains(upper, "ALL_COLUMNS"):
		return &xuguStaticRows{
			columns: []string{"COL_NAME", "TYPE_NAME", "NOT_NULL", "DEF_VAL", "COMMENTS", "SCALE", "VARYING"},
			values:  [][]driver.Value{{"PRODUCT_ID", "INTEGER", true, nil, nil, int64(-1), false}},
		}, nil
	default:
		return nil, fmt.Errorf("unexpected query: %s", query)
	}
}

type xuguStaticRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

func (r *xuguStaticRows) Columns() []string { return r.columns }
func (r *xuguStaticRows) Close() error      { return nil }
func (r *xuguStaticRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	copy(dest, r.values[r.index])
	r.index++
	return nil
}

var xuguBlockingUnblock chan struct{}

// resetXuguBlockingDriver creates a fresh unblock channel for the blocking
// driver. Call before each test that uses "xugu-test-blocking".
func resetXuguBlockingDriver() {
	xuguBlockingUnblock = make(chan struct{})
}

type xuguBlockingDriver struct{}

func (d *xuguBlockingDriver) Open(name string) (driver.Conn, error) {
	return &xuguBlockingConn{}, nil
}

type xuguBlockingConn struct{}

func (c *xuguBlockingConn) Prepare(query string) (driver.Stmt, error) {
	return &xuguBlockingStmt{}, nil
}
func (c *xuguBlockingConn) Close() error              { return nil }
func (c *xuguBlockingConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }

type xuguBlockingStmt struct{}

func (s *xuguBlockingStmt) Close() error  { return nil }
func (s *xuguBlockingStmt) NumInput() int { return -1 }
func (s *xuguBlockingStmt) Exec(args []driver.Value) (driver.Result, error) {
	<-xuguBlockingUnblock
	return nil, errors.New("killed")
}
func (s *xuguBlockingStmt) Query(args []driver.Value) (driver.Rows, error) {
	<-xuguBlockingUnblock
	return nil, errors.New("killed")
}

type xuguFastDriver struct{}

func (d *xuguFastDriver) Open(name string) (driver.Conn, error) {
	return &xuguFastConn{}, nil
}

type xuguFastConn struct{}

func (c *xuguFastConn) Prepare(query string) (driver.Stmt, error) {
	return &xuguFastStmt{}, nil
}
func (c *xuguFastConn) Close() error              { return nil }
func (c *xuguFastConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }

type xuguFastStmt struct{}

func (s *xuguFastStmt) Close() error  { return nil }
func (s *xuguFastStmt) NumInput() int { return -1 }
func (s *xuguFastStmt) Exec(args []driver.Value) (driver.Result, error) {
	return driver.ResultNoRows, nil
}
func (s *xuguFastStmt) Query(args []driver.Value) (driver.Rows, error) {
	return &xuguFastRows{}, nil
}

type xuguFastRows struct {
	pos    int
	closed bool
}

func (r *xuguFastRows) Columns() []string { return []string{"id"} }
func (r *xuguFastRows) Close() error      { r.closed = true; return nil }
func (r *xuguFastRows) Next(dest []driver.Value) error {
	if r.pos >= 3 || r.closed {
		return io.EOF
	}
	dest[0] = int64(r.pos + 1)
	r.pos++
	return nil
}

// -- timeout tests --

func TestXuguWatchdogFiresKillAndCancel(t *testing.T) {
	s := newServer()
	killCh := make(chan struct{})
	s.killSession = func() { close(killCh) }

	ctx, cancel := s.beginActiveOperationWithTimeout(0)
	cancel() // clean up the initial call

	ctx, cancel = s.beginActiveOperationWithTimeout(1)
	defer func() {
		s.activeCancelMu.Lock()
		if s.activeTimer != nil {
			s.activeTimer.Stop()
		}
		s.activeCancelMu.Unlock()
		cancel()
	}()

	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("watchdog timer did not fire within 2 seconds")
	}

	select {
	case <-killCh:
	case <-time.After(time.Second):
		t.Fatal("killSession was not called after watchdog cancellation")
	}
}

func TestXuguNoWatchdogWhenTimeoutZero(t *testing.T) {
	s := newServer()
	var killed bool
	var killMu sync.Mutex
	s.killSession = func() {
		killMu.Lock()
		killed = true
		killMu.Unlock()
	}

	ctx, cancel := s.beginActiveOperationWithTimeout(0)
	defer cancel()

	s.activeCancelMu.Lock()
	hasTimer := s.activeTimer != nil
	timedOut := s.activeTimedOut
	s.activeCancelMu.Unlock()

	if hasTimer {
		t.Fatal("timer should not be created when timeoutSecs=0")
	}
	if timedOut {
		t.Fatal("activeTimedOut should be false when timeoutSecs=0")
	}

	select {
	case <-ctx.Done():
		t.Fatal("context should not be cancelled when timeoutSecs=0")
	default:
	}

	killMu.Lock()
	if killed {
		t.Fatal("killSession should not be called when timeoutSecs=0")
	}
	killMu.Unlock()
}

func TestXuguCursorSurvivesDeadlineWindow(t *testing.T) {
	s := newServer()
	var killed bool
	var killMu sync.Mutex
	s.killSession = func() {
		killMu.Lock()
		killed = true
		killMu.Unlock()
	}

	db, err := sql.Open("xugu-test-fast", "dsn")
	if err != nil {
		t.Fatal(err)
	}
	s.db = db
	s.cancelDB = db

	rows, err := s.queryRowsWithTimeout("SELECT id FROM test", nil, 1)
	if err != nil {
		t.Fatalf("queryRowsWithTimeout failed: %v", err)
	}
	defer s.closeRows(rows)

	s.activeCancelMu.Lock()
	timerStopped := s.activeTimer == nil
	s.activeCancelMu.Unlock()
	if !timerStopped {
		t.Fatal("timer should be stopped after QueryContext returns")
	}

	time.Sleep(1200 * time.Millisecond)

	// Read all rows to verify cursor survived the deadline window.
	cols, _ := rows.Columns()
	values := make([]any, len(cols))
	for i := range values {
		values[i] = new(any)
	}
	rowCount := 0
	for rows.Next() {
		rowCount++
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("cursor was killed by deadline: %v", err)
	}
	if rowCount != 3 {
		t.Fatalf("expected 3 rows, got %d", rowCount)
	}

	killMu.Lock()
	if killed {
		t.Fatal("killSession should not be called when query completes normally")
	}
	killMu.Unlock()
}

func TestXuguWatchdogCallsKillOnBlockingQuery(t *testing.T) {
	resetXuguBlockingDriver()

	s := newServer()
	killCh := make(chan struct{})
	s.killSession = func() { close(killCh) }

	db, err := sql.Open("xugu-test-blocking", "dsn")
	if err != nil {
		t.Fatal(err)
	}
	s.db = db
	s.cancelDB = db

	errCh := make(chan error, 1)
	go func() {
		_, err := s.queryRowsWithTimeout("SELECT 1", nil, 1)
		errCh <- err
	}()

	select {
	case <-killCh:
		// kill was called as expected
	case <-time.After(3 * time.Second):
		t.Fatal("killSession was not called within timeout window")
	}

	// Unblock the fake driver so queryRowsWithTimeout can return.
	close(xuguBlockingUnblock)

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected non-nil error after kill")
		}
		if !strings.Contains(err.Error(), "killed") && !strings.Contains(err.Error(), "timed out") {
			t.Fatalf("expected killed or timeout error, got: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("query did not return after unblocking driver")
	}
}
