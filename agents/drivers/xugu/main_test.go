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

func TestBuildDSNOverridesSelectedDatabase(t *testing.T) {
	tests := []struct {
		name   string
		params connectParams
		want   string
	}{
		{
			name: "native DSN",
			params: connectParams{
				Database:         "SHOP_DEMO",
				ConnectionString: "IP=db.example.com;DB=SYSTEM;User=SYSDBA;PWD=secret;Port=5138",
			},
			want: "IP=db.example.com;DB=SHOP_DEMO;User=SYSDBA;PWD=secret;Port=5138",
		},
		{
			name: "JDBC URL",
			params: connectParams{
				Database:         "SHOP_DEMO",
				Username:         "sysdba",
				Password:         "secret",
				ConnectionString: "jdbc:xugu://db.example.com:15138/SYSTEM?note=DB=shadow",
				URLParams:        "TRACE_LABEL=DB=SYSTEM",
			},
			want: "IP=db.example.com;DB=SHOP_DEMO;User=sysdba;PWD=secret;Port=15138;CHAR_SET=UTF8;TRACE_LABEL=DB=SYSTEM",
		},
		{
			name: "DBX URL",
			params: connectParams{
				Database:         "SHOP_DEMO",
				ConnectionString: "xugu://sysdba:secret@db.example.com:15138/SYSTEM?note=DB=shadow",
				URLParams:        "TRACE_LABEL=DB=SYSTEM",
			},
			want: "IP=db.example.com;DB=SHOP_DEMO;User=sysdba;PWD=secret;Port=15138;CHAR_SET=UTF8;TRACE_LABEL=DB=SYSTEM",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := buildDSN(test.params); got != test.want {
				t.Fatalf("unexpected dsn:\n got: %s\nwant: %s", got, test.want)
			}
		})
	}
}

func TestBuildDSNPreservesConnectionDatabaseWithoutSelection(t *testing.T) {
	tests := []struct {
		name   string
		params connectParams
		want   string
	}{
		{
			name: "native DSN",
			params: connectParams{
				Database:         "   ",
				ConnectionString: "IP=db.example.com;DB=SYSTEM;User=SYSDBA;PWD=secret;Port=5138",
			},
			want: "IP=db.example.com;DB=SYSTEM;User=SYSDBA;PWD=secret;Port=5138",
		},
		{
			name: "JDBC URL",
			params: connectParams{
				Username:         "sysdba",
				Password:         "secret",
				ConnectionString: "jdbc:xugu://db.example.com:15138/SYSTEM",
			},
			want: "IP=db.example.com;DB=SYSTEM;User=sysdba;PWD=secret;Port=15138;CHAR_SET=UTF8",
		},
		{
			name: "DBX URL",
			params: connectParams{
				ConnectionString: "xugu://sysdba:secret@db.example.com:15138/SYSTEM",
			},
			want: "IP=db.example.com;DB=SYSTEM;User=sysdba;PWD=secret;Port=15138;CHAR_SET=UTF8",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := buildDSN(test.params); got != test.want {
				t.Fatalf("unexpected dsn:\n got: %s\nwant: %s", got, test.want)
			}
		})
	}
}

func TestBuildDSNOverridesOnlyNativeDatabaseParameters(t *testing.T) {
	dsn := buildDSN(connectParams{
		Database:         "  sales;east's  ",
		ConnectionString: "IP=db.example.com;DB=SYSTEM;User=SYSDBA;PWD='secret;DB=shadow';Port=5138;NOTE='DB=archive;keep';db=LEGACY",
	})
	want := "IP=db.example.com;DB='sales;east''s';User=SYSDBA;PWD='secret;DB=shadow';Port=5138;NOTE='DB=archive;keep';db='sales;east''s'"

	if dsn != want {
		t.Fatalf("unexpected dsn:\n got: %s\nwant: %s", dsn, want)
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

func TestTableChildMetadataUsesLowPrivilegeDictionary(t *testing.T) {
	for name, query := range map[string]string{
		"constraints":   xuguTableConstraintsSQL,
		"foreign keys":  xuguTableForeignKeysSQL,
		"partitions":    xuguTablePartitionsSQL,
		"subpartitions": xuguTableSubpartitionsSQL,
	} {
		upper := strings.ToUpper(query)
		if !strings.Contains(upper, "ALL_") {
			t.Fatalf("%s metadata should query ALL_* views: %s", name, query)
		}
		if strings.Contains(upper, "SYS_") {
			t.Fatalf("%s metadata must not require SYS_* privileges: %s", name, query)
		}
	}
	if !strings.Contains(strings.ToUpper(xuguTableConstraintsSQL), "C.CONS_TYPE <> 'F'") {
		t.Fatalf("generic constraints must exclude foreign keys: %s", xuguTableConstraintsSQL)
	}
	if !strings.Contains(strings.ToUpper(xuguTableForeignKeysSQL), "C.CONS_TYPE = 'F'") {
		t.Fatalf("foreign-key metadata must query only foreign keys: %s", xuguTableForeignKeysSQL)
	}
}

func TestTableChildMetadataPresentationHelpers(t *testing.T) {
	if got := xuguConstraintTypeName("F"); got != "FOREIGN KEY" {
		t.Fatalf("foreign key type = %q", got)
	}
	if got := xuguMatchTypeName("U"); got != "SIMPLE" {
		t.Fatalf("simple match type = %q", got)
	}
	if got := xuguAutoPartitionUnit(2); got != "MONTH" {
		t.Fatalf("auto partition unit = %q", got)
	}
}

func TestTableChildMetadataRPCsReturnCatalogObjects(t *testing.T) {
	db, err := sql.Open("xugu-test-table-objects", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	s := newServer()
	s.db = db
	s.params.Database = "SHOP_DEMO"

	for _, test := range []struct {
		method string
		want   string
	}{
		{method: "list_constraints", want: "PRIMARY KEY"},
		{method: "list_partitions", want: "RANGE"},
		{method: "list_subpartitions", want: "LIST"},
	} {
		response, shutdown := s.handleLine(fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"%s","params":{"database":"SHOP_DEMO","schema":"SYSDBA","table":"SHOP_ORDERS"}}`, test.method))
		if shutdown || response.Error != nil {
			t.Fatalf("%s failed: shutdown=%v error=%v", test.method, shutdown, response.Error)
		}
		encoded, err := json.Marshal(response.Result)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(encoded), test.want) {
			t.Fatalf("%s result did not contain %q: %s", test.method, test.want, encoded)
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

func TestXuguListObjectsQueryExcludesSystemSequences(t *testing.T) {
	query := xuguListObjectsQuery("APP", metadataListConstraints{
		ObjectTypes: []string{"sequence"},
	})

	if !strings.Contains(query.SQL, "q.IS_SYS = FALSE") {
		t.Fatalf("sequence lookup must exclude system-managed identity sequences:\n%s", query.SQL)
	}
}

func TestGetSequenceSourceReconstructsExecutableDDL(t *testing.T) {
	db, err := sql.Open("xugu-test-sequence-source", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	s := newServer()
	s.db = db
	source, err := s.getObjectSource("AppSchema", "seqOrderNo", "SEQUENCE")
	if err != nil {
		t.Fatalf("get sequence source: %v", err)
	}
	if source["editable"] != false {
		t.Fatalf("sequence source must remain read-only: %#v", source)
	}
	if source["schema"] != "AppSchema" || source["name"] != "seqOrderNo" {
		t.Fatalf("sequence source must preserve catalog spelling: %#v", source)
	}

	ddl, _ := source["source"].(string)
	for _, want := range []string{
		`CREATE SEQUENCE "AppSchema"."seqOrderNo"`,
		"INCREMENT BY 10",
		"START WITH 500",
		"MINVALUE -100",
		"MAXVALUE 10000",
		"CACHE 20",
		"CYCLE",
		"COMMENT 'order''s next number'",
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("sequence DDL is missing %q:\n%s", want, ddl)
		}
	}
	if !strings.HasSuffix(strings.TrimSpace(ddl), ";") {
		t.Fatalf("sequence DDL must end with a statement terminator:\n%s", ddl)
	}
}

func TestRenderXuguSequenceDDLUsesNoCacheAndNoCycle(t *testing.T) {
	ddl := renderXuguSequenceDDL(xuguSequenceMetadata{
		Schema: "APP", Name: "SEQ_DEFAULTS", Current: int64(1), Minimum: int64(1),
		Maximum: int64(9223372036854775807), Step: int64(1), Cache: int64(1), Cycle: false,
	})
	for _, want := range []string{"NOCACHE", "NOCYCLE"} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("sequence DDL is missing %q:\n%s", want, ddl)
		}
	}
	if strings.Contains(ddl, "NO CYCLE") {
		t.Fatalf("sequence DDL must use Xugu's NOCYCLE spelling:\n%s", ddl)
	}
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

func TestParseQuotedIdentifiersHandlesEscapedQuotesAndDelimiters(t *testing.T) {
	definition := `("a""b","comma,name","paren(name)")("id""q","ref,code","ref(paren)")`
	local, ref := parseForeignKeyColumns(definition)
	if got, want := strings.Join(local, "|"), `a"b|comma,name|paren(name)`; got != want {
		t.Fatalf("local columns = %q, want %q", got, want)
	}
	if got, want := strings.Join(ref, "|"), `id"q|ref,code|ref(paren)`; got != want {
		t.Fatalf("referenced columns = %q, want %q", got, want)
	}
	if got, want := strings.Join(parseIndexKeys(`"a""b","comma,name","paren(name)"`), "|"), `a"b|comma,name|paren(name)`; got != want {
		t.Fatalf("index keys = %q, want %q", got, want)
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
		// Foreign keys are emitted after CREATE TABLE (ALTER), not inline.
		`ALTER TABLE "APP"."CHILD" ADD CONSTRAINT "FK_CHILD_PARENT" FOREIGN KEY ("PARENT_ID") REFERENCES "APP"."PARENT" ("ID") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE`,
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
	// Ensure FK is not declared inside the CREATE TABLE body.
	createBody := ddl
	if idx := strings.Index(ddl, "ALTER TABLE"); idx >= 0 {
		createBody = ddl[:idx]
	}
	if strings.Contains(createBody, "FOREIGN KEY") {
		t.Fatalf("foreign keys must not be inlined in CREATE TABLE:\n%s", ddl)
	}
	if !strings.HasSuffix(strings.TrimSpace(ddl), ";") {
		t.Fatalf("standalone table DDL must end with a statement terminator:\n%s", ddl)
	}
}

func TestRenderXuguTableDDLSkipsImplicitIdentityUniqueConstraint(t *testing.T) {
	ddl := renderXuguTableDDL(
		"AppSchema", "tbIdentityAndDefaults",
		[]columnInfo{
			{Name: "identityStandard", DataType: "INTEGER", IsNullable: false},
			{Name: "identityCustom", DataType: "INTEGER", IsNullable: false},
			{Name: "other", DataType: "VARCHAR", IsNullable: false},
		},
		xuguTableMetadata{},
		map[string]xuguIdentityInfo{
			"identityStandard": {Column: "identityStandard", Start: 1, Step: 1, SystemGenerated: true},
			"identityCustom":   {Column: "identityCustom", Start: 100, Step: 10, SystemGenerated: true},
		},
		[]xuguConstraintInfo{
			{Name: "PK_S1", Type: "P", Definition: `"identityStandard"`},
			{Name: "UK_S1", Type: "U", Definition: `"identityCustom"`, SystemGenerated: true},
			{Name: "UK_OTHER", Type: "U", Definition: `"other"`},
		},
		nil, nil,
	)
	if strings.Contains(ddl, `CONSTRAINT "UK_S1" UNIQUE ("identityCustom")`) {
		t.Fatalf("implicit IDENTITY unique constraint must not be exported:\n%s", ddl)
	}
	if !strings.Contains(ddl, `CONSTRAINT "UK_OTHER" UNIQUE ("other")`) {
		t.Fatalf("ordinary unique constraint must be preserved:\n%s", ddl)
	}
}

func TestIdentityUniqueConstraintRequiresSystemGeneratedIdentityMetadata(t *testing.T) {
	constraint := xuguConstraintInfo{Name: "UK_ID", Type: "U", Definition: `"id"`}
	if shouldSkipXuguIdentityUniqueConstraint(constraint, map[string]xuguIdentityInfo{
		"id": {Column: "id", SystemGenerated: true},
	}) {
		t.Fatal("a user UNIQUE constraint on an IDENTITY column must be preserved")
	}
	constraint.SystemGenerated = true
	if shouldSkipXuguIdentityUniqueConstraint(constraint, map[string]xuguIdentityInfo{
		"id": {Column: "id", SystemGenerated: false},
	}) {
		t.Fatal("a generated UNIQUE constraint on a user sequence must be preserved")
	}
	if !shouldSkipXuguIdentityUniqueConstraint(constraint, map[string]xuguIdentityInfo{
		"id": {Column: "id", SystemGenerated: true},
	}) {
		t.Fatal("the system-generated IDENTITY unique constraint must be suppressed")
	}
}

func TestBuildTableDDLPreservesUserUniqueConstraintOnIdentityColumn(t *testing.T) {
	db, err := sql.Open("xugu-test-table-ddl", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	s := newServer()
	s.db = db
	ddl, err := s.buildTableDDL("APP", "CHILD")
	if err != nil {
		t.Fatalf("build table DDL: %v", err)
	}
	if !strings.Contains(ddl, `CONSTRAINT "UK_CHILD_ID" UNIQUE ("ID")`) {
		t.Fatalf("user UNIQUE constraint on IDENTITY column must be preserved:\n%s", ddl)
	}
	if strings.Contains(ddl, `CONSTRAINT "UK_SYS_ID" UNIQUE ("ID")`) {
		t.Fatalf("system-generated IDENTITY unique constraint must be suppressed:\n%s", ddl)
	}
}

func TestBuildTableDDLReadsForeignKeysFromCatalog(t *testing.T) {
	db, err := sql.Open("xugu-test-table-ddl", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	s := newServer()
	s.db = db
	ddl, err := s.buildTableDDL("APP", "CHILD")
	if err != nil {
		t.Fatalf("build table DDL: %v", err)
	}

	want := `ALTER TABLE "APP"."CHILD" ADD CONSTRAINT "FK_CHILD_PARENT" FOREIGN KEY ("PARENT_ID") REFERENCES "APP"."PARENT" ("ID") ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE`
	if !strings.Contains(ddl, want) {
		t.Fatalf("catalog foreign key missing from reconstructed DDL:\n%s", ddl)
	}
	createBody := ddl[:strings.Index(ddl, "ALTER TABLE")]
	if strings.Contains(createBody, "FOREIGN KEY") {
		t.Fatalf("catalog foreign key must be emitted after CREATE TABLE:\n%s", ddl)
	}
	foreignKeys, err := s.listForeignKeys("APP", "CHILD")
	if err != nil || len(foreignKeys) != 1 || foreignKeys[0].Name != "FK_CHILD_PARENT" {
		t.Fatalf("dedicated foreign-key catalog query = %#v, err=%v", foreignKeys, err)
	}
}

func TestDDLMetadataLexerPreservesQuotedConstraintAndIndexColumns(t *testing.T) {
	constraints := []xuguConstraintInfo{
		{Name: `PK"quoted`, Type: "P", Definition: `"id""value"`},
		{Name: `UK,quoted`, Type: "U", Definition: `"comma,name","paren(name)"`},
		{
			Name: `FK"quoted`, Type: "F", Definition: `("child""id","child,name")("parent""id","parent,name")`,
			ReferenceSchema: `App"Schema`, ReferenceTable: `Parent,Table`, UpdateAction: "n", DeleteAction: "c",
		},
	}
	ddl := renderXuguTableDDL("APP", "CHILD", []columnInfo{{Name: `id"value`, DataType: "INTEGER", IsNullable: false}}, xuguTableMetadata{}, nil, constraints, nil, nil)
	for _, want := range []string{
		`CONSTRAINT "PK""quoted" PRIMARY KEY ("id""value")`,
		`CONSTRAINT "UK,quoted" UNIQUE ("comma,name","paren(name)")`,
		`ALTER TABLE "APP"."CHILD" ADD CONSTRAINT "FK""quoted" FOREIGN KEY ("child""id", "child,name") REFERENCES "App""Schema"."Parent,Table" ("parent""id", "parent,name")`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("DDL missing escaped identifier fragment %q:\n%s", want, ddl)
		}
	}
	if !shouldSkipIndexForTableDDL(indexInfo{Name: "UK_BACKING", Columns: []string{"comma,name", "paren(name)"}, IsUnique: true}, uniqueKeyColumnSets(constraints)) {
		t.Fatal("unique index with quoted comma/parenthesis columns should match its UNIQUE constraint")
	}
}

func TestXuguIndexKeysPreserveOrderingAndExpressions(t *testing.T) {
	keys := parseXuguIndexKeys(`"CODE" DESC, LOWER("CODE"), "ID" ASC, "plain"`)
	if got, want := len(keys), 4; got != want {
		t.Fatalf("index key count = %d, want %d", got, want)
	}
	got := make([]string, 0, len(keys))
	for _, key := range keys {
		got = append(got, renderXuguIndexKey(key))
	}
	if want := `"CODE" DESC, LOWER("CODE"), "ID" ASC, "plain"`; strings.Join(got, ", ") != want {
		t.Fatalf("rendered index keys = %q, want %q", strings.Join(got, ", "), want)
	}

	constraintColumns := uniqueKeyColumnSets([]xuguConstraintInfo{{Name: "UK_CODE", Type: "U", Definition: `"CODE"`}})
	if shouldSkipIndexForTableDDL(indexInfo{IsUnique: true, Columns: []string{"CODE"}, keys: parseXuguIndexKeys(`"CODE" DESC`)}, constraintColumns) {
		t.Fatal("ordered unique index must not be treated as a UNIQUE constraint backing index")
	}
	if shouldSkipIndexForTableDDL(indexInfo{IsUnique: true, Columns: []string{"CODE"}, keys: parseXuguIndexKeys(`LOWER("CODE")`)}, constraintColumns) {
		t.Fatal("expression unique index must not be treated as a UNIQUE constraint backing index")
	}
	if !shouldSkipIndexForTableDDL(indexInfo{IsUnique: true, Columns: []string{"CODE"}, keys: parseXuguIndexKeys(`"CODE"`)}, constraintColumns) {
		t.Fatal("plain unique index matching a UNIQUE constraint must still be skipped")
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
		`ALTER TABLE "APP"."CHILD" ADD CONSTRAINT "FK_CHILD_PARENT" FOREIGN KEY ("A", "B") REFERENCES "APP"."PARENT" ("A", "B") MATCH FULL`,
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

func TestRenderXuguTableDDLTerminatesStandaloneScript(t *testing.T) {
	ddl := renderXuguTableDDL("AppSchema", "tbNoIndex", []columnInfo{{Name: "id", DataType: "INTEGER", IsNullable: false}}, xuguTableMetadata{}, nil, nil, nil, nil)
	if got, want := ddl, "CREATE TABLE \"AppSchema\".\"tbNoIndex\" (\n  \"id\" INTEGER NOT NULL\n);"; got != want {
		t.Fatalf("standalone DDL = %q, want %q", got, want)
	}
}

func TestShouldSkipIndexForTableDDL(t *testing.T) {
	uniqueCols := uniqueKeyColumnSets([]xuguConstraintInfo{
		{Name: "PK_T", Type: "P", Definition: `"ID"`},
		{Name: "UK_T_CODE", Type: "U", Definition: `"CODE"`},
	})
	tests := []struct {
		name  string
		index indexInfo
		skip  bool
	}{
		{name: "primary index", index: indexInfo{Name: "PK_IDX", Columns: []string{"ID"}, IsPrimary: true, IsUnique: true}, skip: true},
		{name: "unique constraint backing index", index: indexInfo{Name: "UK_IDX", Columns: []string{"CODE"}, IsUnique: true}, skip: true},
		{name: "quoted case-distinct unique index", index: indexInfo{Name: "UK_IDX_CASE", Columns: []string{"Code"}, IsUnique: true}, skip: false},
		{name: "non-unique secondary index", index: indexInfo{Name: "IX_NAME", Columns: []string{"NAME"}, IsUnique: false}, skip: false},
		{name: "unique index on other columns", index: indexInfo{Name: "UX_OTHER", Columns: []string{"OTHER"}, IsUnique: true}, skip: false},
		{name: "empty columns", index: indexInfo{Name: "BAD", Columns: nil, IsUnique: true}, skip: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldSkipIndexForTableDDL(tt.index, uniqueCols); got != tt.skip {
				t.Fatalf("shouldSkipIndexForTableDDL(%+v) = %v, want %v", tt.index, got, tt.skip)
			}
		})
	}
}

func TestNormalizeXuguDefaultExpr(t *testing.T) {
	tests := []struct {
		in, dataType, want string
	}{
		{in: `"SYSDATE"`, dataType: "DATETIME", want: "SYSDATE"},
		{in: `"sysdate"`, dataType: "DATETIME", want: "SYSDATE"},
		{in: "SYSDATE", dataType: "DATETIME", want: "SYSDATE"},
		{in: "(GETDATE())", dataType: "DATETIME", want: "SYSDATE"},
		{in: "uuid()", dataType: "CHAR", want: "SYS_GUID()"},
		{in: "'UUID()'", dataType: "VARCHAR", want: "'UUID()'"},
		{in: "CASE WHEN flag = 1 THEN 'UUID()' ELSE 'x' END", dataType: "VARCHAR", want: "CASE WHEN flag = 1 THEN 'UUID()' ELSE 'x' END"},
		{in: "0000-00-00 00:00:00", dataType: "DATETIME", want: "0000-00-00 00:00:00"},
		{in: "0000-00-00", dataType: "DATE", want: "0000-00-00"},
		{in: "'plain'", dataType: "VARCHAR", want: "'plain'"},
		{in: "0", dataType: "INTEGER", want: "0"},
		{in: "''", dataType: "INTEGER", want: "''"},
		{in: "''", dataType: "VARCHAR", want: "''"},
		{in: "- (1)", dataType: "INTEGER", want: "-1"},
	}
	for _, tt := range tests {
		if got := normalizeXuguDefaultExpr(tt.in, tt.dataType); got != tt.want {
			t.Fatalf("normalizeXuguDefaultExpr(%q, %q) = %q, want %q", tt.in, tt.dataType, got, tt.want)
		}
	}
}

func TestRenderXuguTableDDLNormalizesQuotedSysdateDefault(t *testing.T) {
	def := `"SYSDATE"`
	ddl := renderXuguTableDDL("APP", "T",
		[]columnInfo{{Name: "TS", DataType: "DATETIME", IsNullable: false, ColumnDefault: &def}},
		xuguTableMetadata{}, nil, nil, nil, nil)
	if !strings.Contains(ddl, `DEFAULT SYSDATE`) {
		t.Fatalf("expected unquoted SYSDATE default, got:\n%s", ddl)
	}
	if strings.Contains(ddl, `DEFAULT "SYSDATE"`) {
		t.Fatalf("quoted SYSDATE default should be normalized:\n%s", ddl)
	}
}

func TestQuoteStringLiteralEscapesSingleQuotes(t *testing.T) {
	if got := quoteStringLiteral("owner's note"); got != "'owner''s note'" {
		t.Fatalf("unexpected quoted string: %s", got)
	}
}

func TestQuoteIdentifierPreservesCase(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{in: "tibms_sx_agent", want: `"tibms_sx_agent"`},
		{in: "tb_FileTrans", want: `"tb_FileTrans"`},
		{in: "hgListId", want: `"hgListId"`},
		{in: `weird"name`, want: `"weird""name"`},
	}
	for _, tt := range tests {
		if got := quoteIdentifier(tt.in); got != tt.want {
			t.Fatalf("quoteIdentifier(%q) = %s, want %s", tt.in, got, tt.want)
		}
	}
}

func TestSelectXuguCatalogTableNamePrefersExactCaseAndRejectsAmbiguity(t *testing.T) {
	candidates := []xuguCatalogTableName{
		{Schema: "SYSDBA", Table: "DBX_CASE_TABLE"},
		{Schema: "SYSDBA", Table: "dbx_case_table"},
	}

	schema, table, err := selectXuguCatalogTableName("SYSDBA", "dbx_case_table", candidates)
	if err != nil || schema != "SYSDBA" || table != "dbx_case_table" {
		t.Fatalf("exact-case selection = (%q, %q, %v), want lower-case catalog table", schema, table, err)
	}

	if _, _, err := selectXuguCatalogTableName("SYSDBA", "Dbx_Case_Table", candidates); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("mixed-case ambiguous selection error = %v, want ambiguity error", err)
	}

	schema, table, err = selectXuguCatalogTableName("sysdba", "dbx_plain_table", []xuguCatalogTableName{{Schema: "SYSDBA", Table: "DBX_PLAIN_TABLE"}})
	if err != nil || schema != "SYSDBA" || table != "DBX_PLAIN_TABLE" {
		t.Fatalf("single-candidate fallback = (%q, %q, %v), want catalog spelling", schema, table, err)
	}
}

func TestSelectXuguCatalogSequenceNamePrefersExactCaseAndRejectsAmbiguity(t *testing.T) {
	candidates := []xuguCatalogSequenceName{
		{Schema: "AppSchema", Name: "seqOrderNo"},
		{Schema: "AppSchema", Name: "SEQORDERNO"},
	}

	schema, name, err := selectXuguCatalogSequenceName("AppSchema", "seqOrderNo", candidates)
	if err != nil || schema != "AppSchema" || name != "seqOrderNo" {
		t.Fatalf("exact-case selection = (%q, %q, %v), want quoted catalog sequence", schema, name, err)
	}

	if _, _, err := selectXuguCatalogSequenceName("AppSchema", "SeqOrderNo", candidates); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("mixed-case ambiguous selection error = %v, want ambiguity error", err)
	}

	schema, name, err = selectXuguCatalogSequenceName("appschema", "seq_plain", []xuguCatalogSequenceName{{Schema: "APPSCHEMA", Name: "SEQ_PLAIN"}})
	if err != nil || schema != "APPSCHEMA" || name != "SEQ_PLAIN" {
		t.Fatalf("single-candidate fallback = (%q, %q, %v), want catalog spelling", schema, name, err)
	}
}

func TestCatalogTableLookupQueriesAvoidCaseFoldingBoundParameters(t *testing.T) {
	exact := xuguCatalogTableNameQuery("S'CHEMA", "MiX'ed", false)
	if strings.Contains(strings.ToUpper(exact), "UPPER(") {
		t.Fatalf("exact catalog lookup must not case-fold identifiers:\n%s", exact)
	}
	if !strings.Contains(exact, "s.SCHEMA_NAME = 'S''CHEMA'") || !strings.Contains(exact, "t.TABLE_NAME = 'MiX''ed'") {
		t.Fatalf("exact catalog lookup must escape and preserve identifier spelling:\n%s", exact)
	}

	folded := xuguCatalogTableNameQuery("S'CHEMA", "MiX'ed", true)
	if strings.Contains(folded, "UPPER(?)") {
		t.Fatalf("case-insensitive lookup must not call UPPER(?) on bound parameters:\n%s", folded)
	}
	for _, fragment := range []string{"UPPER(s.SCHEMA_NAME) = 'S''CHEMA'", "UPPER(t.TABLE_NAME) = 'MIX''ED'"} {
		if !strings.Contains(folded, fragment) {
			t.Fatalf("case-insensitive lookup missing %q:\n%s", fragment, folded)
		}
	}
}

func TestCatalogSequenceLookupQueriesPreferExactIdentifiers(t *testing.T) {
	exact := xuguCatalogSequenceNameQuery("App'Schema", "seq'MixedCase", false)
	if strings.Contains(strings.ToUpper(exact), "UPPER(") {
		t.Fatalf("exact sequence lookup must not case-fold identifiers:\n%s", exact)
	}
	for _, fragment := range []string{"q.IS_SYS = FALSE", "s.SCHEMA_NAME = 'App''Schema'", "q.SEQ_NAME = 'seq''MixedCase'"} {
		if !strings.Contains(exact, fragment) {
			t.Fatalf("exact sequence lookup missing %q:\n%s", fragment, exact)
		}
	}

	folded := xuguCatalogSequenceNameQuery("App'Schema", "seq'MixedCase", true)
	if strings.Contains(folded, "UPPER(?)") {
		t.Fatalf("case-insensitive sequence lookup must not call UPPER(?) on bound parameters:\n%s", folded)
	}
	for _, fragment := range []string{"q.IS_SYS = FALSE", "UPPER(s.SCHEMA_NAME) = 'APP''SCHEMA'", "UPPER(q.SEQ_NAME) = 'SEQ''MIXEDCASE'"} {
		if !strings.Contains(folded, fragment) {
			t.Fatalf("case-insensitive sequence lookup missing %q:\n%s", fragment, folded)
		}
	}
}

func TestTableDDLCatalogQueriesUseExactIdentifiers(t *testing.T) {
	queries := map[string]string{
		"primary key":    xuguPrimaryKeyColumnsSQL,
		"columns":        xuguListColumnsSQL,
		"legacy columns": xuguLegacyListColumnsSQL,
		"indexes":        xuguListIndexesSQL,
		"table metadata": xuguTableMetadataSQL,
		"identities":     xuguTableIdentitySQL,
		"constraints":    xuguTableConstraintsSQL,
		"foreign keys":   xuguTableForeignKeysSQL,
		"partitions":     xuguTablePartitionsSQL,
		"subpartitions":  xuguTableSubpartitionsSQL,
	}
	for name, query := range queries {
		t.Run(name, func(t *testing.T) {
			upper := strings.ToUpper(query)
			if strings.Contains(upper, "UPPER(S.SCHEMA_NAME)") || strings.Contains(upper, "UPPER(T.TABLE_NAME)") {
				t.Fatalf("%s query must not case-fold resolved catalog identifiers:\n%s", name, query)
			}
			if !strings.Contains(query, "s.SCHEMA_NAME = ?") || !strings.Contains(query, "t.TABLE_NAME = ?") {
				t.Fatalf("%s query must match resolved catalog identifiers exactly:\n%s", name, query)
			}
		})
	}
}

func TestTableCatalogQueryEscapesAndPreservesMixedCaseIdentifiers(t *testing.T) {
	query := xuguTableCatalogQuery(xuguListColumnsSQL, "MiX'Schema", "TaB'le")
	if strings.Contains(query, "?") {
		t.Fatalf("resolved table metadata query must not retain bound identifier placeholders:\n%s", query)
	}
	for _, want := range []string{"s.SCHEMA_NAME = 'MiX''Schema'", "t.TABLE_NAME = 'TaB''le'"} {
		if !strings.Contains(query, want) {
			t.Fatalf("resolved table metadata query missing %q:\n%s", want, query)
		}
	}
}

func TestRenderXuguTableDDLPreservesQuotedIdentifierCase(t *testing.T) {
	ddl := renderXuguTableDDL(
		"tibms_sx_agent", "tb_FileTrans",
		[]columnInfo{
			{Name: "hgListId", DataType: "VARCHAR", IsNullable: false, CharacterMaximumLength: intPtr(50)},
			{Name: "tableName", DataType: "VARCHAR", IsNullable: false, CharacterMaximumLength: intPtr(50)},
		},
		xuguTableMetadata{},
		nil,
		[]xuguConstraintInfo{{Name: "PK_tb_FileTrans", Type: "P", Definition: `"hgListId"`, Enabled: true}},
		nil, nil,
	)
	for _, want := range []string{
		`CREATE TABLE "tibms_sx_agent"."tb_FileTrans"`,
		`"hgListId" VARCHAR(50) NOT NULL`,
		`"tableName" VARCHAR(50) NOT NULL`,
		`CONSTRAINT "PK_tb_FileTrans" PRIMARY KEY ("hgListId")`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("DDL missing case-preserving fragment %q:\n%s", want, ddl)
		}
	}
	if strings.Contains(ddl, `"TIBMS_SX_AGENT"`) || strings.Contains(ddl, `"TB_FILETRANS"`) || strings.Contains(ddl, `"HGLISTID"`) {
		t.Fatalf("DDL uppercased identifiers that should keep catalog case:\n%s", ddl)
	}
}

func intPtr(v int) *int { return &v }

func TestNormalizeValuePreservesDriverNumericTypes(t *testing.T) {
	if value := normalizeValue(int32(7)); value != int64(7) {
		t.Fatalf("expected int32 to normalize to int64, got %#v", value)
	}
	if value := normalizeValue(float32(1.25)); value != float64(float32(1.25)) {
		t.Fatalf("expected float32 to normalize to float64, got %#v", value)
	}
}

func TestTrimStatementSQLKeepsXuguProgrammableObjectTerminators(t *testing.T) {
	cases := []struct {
		name string
		sql  string
	}{
		{"procedure", "CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;"},
		{"procedure without or replace", "CREATE PROCEDURE p AS BEGIN NULL; END;"},
		{"function", "CREATE OR REPLACE FUNCTION f RETURN INTEGER AS BEGIN RETURN 1; END;"},
		{"function without or replace", "CREATE FUNCTION f RETURN INTEGER AS BEGIN RETURN 1; END;"},
		{"trigger", "CREATE OR REPLACE TRIGGER t BEFORE INSERT ON events FOR EACH ROW BEGIN NULL; END;"},
		{"trigger without or replace", "CREATE TRIGGER t BEFORE INSERT ON events FOR EACH ROW BEGIN NULL; END;"},
		{"package", "CREATE OR REPLACE PACKAGE pkg AS PROCEDURE ping; END pkg;"},
		{"package without or replace", "CREATE PACKAGE pkg AS PROCEDURE ping; END pkg;"},
		{"package body", "CREATE OR REPLACE PACKAGE BODY pkg AS PROCEDURE ping AS BEGIN NULL; END ping; END pkg;"},
		{"force package", "CREATE OR REPLACE FORCE PACKAGE pkg AS PROCEDURE ping; END pkg;"},
		{"noforce package", "CREATE OR REPLACE NOFORCE PACKAGE pkg AS PROCEDURE ping; END pkg;"},
		{"force package body", "CREATE OR REPLACE FORCE PACKAGE BODY pkg AS PROCEDURE ping AS BEGIN NULL; END ping; END pkg;"},
		{"noforce package body", "CREATE OR REPLACE NOFORCE PACKAGE BODY pkg AS PROCEDURE ping AS BEGIN NULL; END ping; END pkg;"},
		{"type body", "CREATE OR REPLACE TYPE BODY obj AS MEMBER PROCEDURE ping IS BEGIN NULL; END; END;"},
		{"type body without or replace", "CREATE TYPE BODY obj AS MEMBER PROCEDURE ping IS BEGIN NULL; END; END;"},
		{"force type body", "CREATE OR REPLACE FORCE TYPE BODY obj AS MEMBER PROCEDURE ping IS BEGIN NULL; END; END;"},
		{"leading comments", "-- generated source\n/* object DDL */\nCREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := trimStatementSQL(tc.sql); got != tc.sql {
				t.Fatalf("trimStatementSQL() = %q, want %q", got, tc.sql)
			}
		})
	}

	if got := trimStatementSQL("CREATE TABLE items (id INTEGER);"); got != "CREATE TABLE items (id INTEGER)" {
		t.Fatalf("regular SQL terminator should be removed, got %q", got)
	}
	// Plain CREATE TYPE ends with ");" and is ordinary SQL — strip the client terminator.
	if got := trimStatementSQL("CREATE OR REPLACE TYPE address_t AS OBJECT (id INT);"); got != "CREATE OR REPLACE TYPE address_t AS OBJECT (id INT)" {
		t.Fatalf("plain TYPE should strip trailing semicolon, got %q", got)
	}
	if got := trimStatementSQL("CREATE TYPE address_t AS OBJECT (id INT);"); got != "CREATE TYPE address_t AS OBJECT (id INT)" {
		t.Fatalf("plain TYPE without OR REPLACE should strip trailing semicolon, got %q", got)
	}
}

func TestExecuteQueryPreservesXuguTypeBodyTerminator(t *testing.T) {
	resetXuguRecordingDriver()
	db, err := sql.Open("xugu-test-recording", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	s := newServer()
	s.db = db
	sqlText := "CREATE OR REPLACE TYPE BODY obj_t AS MEMBER PROCEDURE ping IS BEGIN NULL; END; END;"
	if _, err := s.executeQuery(queryOptions{SQL: sqlText}); err != nil {
		t.Fatalf("executeQuery() error: %v", err)
	}
	if got := recordedXuguSQL(); got != sqlText {
		t.Fatalf("Agent executed %q, want %q", got, sqlText)
	}
}

func TestXuguShowStatementsUseResultSetQueryPath(t *testing.T) {
	resetXuguShowResultDriver()
	db, err := sql.Open("xugu-test-show-result", "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	s := newServer()
	s.db = db

	result, err := s.executeQuery(queryOptions{SQL: "SHOW DB_INFO;"})
	if err != nil {
		t.Fatalf("executeQuery(SHOW DB_INFO): %v", err)
	}
	if got, want := result.Columns, []string{"DB_NAME", "DB_ID", "DB_OWNER", "DB_CHARSET", "DB_TIMEZ"}; !equalStrings(got, want) {
		t.Fatalf("SHOW DB_INFO columns = %v, want %v", got, want)
	}
	if len(result.Rows) != 1 || result.Rows[0][0] != "SYSTEM" {
		t.Fatalf("SHOW DB_INFO rows = %#v, want database row", result.Rows)
	}

	page, err := s.executeQueryPage(queryOptions{SQL: "SHOW DB_INFO"}, 10)
	if err != nil {
		t.Fatalf("executeQueryPage(SHOW DB_INFO): %v", err)
	}
	if len(page.Rows) != 1 || page.Rows[0][0] != "SYSTEM" {
		t.Fatalf("SHOW DB_INFO page rows = %#v, want database row", page.Rows)
	}

	queries, execs := recordedXuguShowStatements()
	if got, want := queries, []string{"SHOW DB_INFO", "SHOW DB_INFO"}; !equalStrings(got, want) {
		t.Fatalf("SHOW statements queried = %v, want %v", got, want)
	}
	if len(execs) != 0 {
		t.Fatalf("SHOW statements must not use ExecContext, got %v", execs)
	}
}

func TestXuguQueryKeywordBoundariesUseResultSetPath(t *testing.T) {
	for _, test := range []struct {
		name        string
		sqlText     string
		wantQuery   string
		wantColumns []string
		wantValue   any
	}{
		{name: "parenthesized select", sqlText: "SELECT(1);", wantQuery: "SELECT(1)", wantColumns: []string{"VALUE"}, wantValue: int64(1)},
		{name: "select hint", sqlText: "SELECT/*+ index */1;", wantQuery: "SELECT/*+ index */1", wantColumns: []string{"VALUE"}, wantValue: int64(1)},
		{name: "show comment", sqlText: "SHOW/* metadata */ DB_INFO;", wantQuery: "SHOW/* metadata */ DB_INFO", wantColumns: []string{"DB_NAME", "DB_ID", "DB_OWNER", "DB_CHARSET", "DB_TIMEZ"}, wantValue: "SYSTEM"},
	} {
		t.Run(test.name, func(t *testing.T) {
			resetXuguShowResultDriver()
			db, err := sql.Open("xugu-test-show-result", "")
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()

			s := newServer()
			s.db = db
			result, err := s.executeQuery(queryOptions{SQL: test.sqlText})
			if err != nil {
				t.Fatalf("executeQuery(%q): %v", test.sqlText, err)
			}
			if !equalStrings(result.Columns, test.wantColumns) {
				t.Fatalf("columns = %v, want %v", result.Columns, test.wantColumns)
			}
			if len(result.Rows) != 1 || len(result.Rows[0]) == 0 || result.Rows[0][0] != test.wantValue {
				t.Fatalf("rows = %#v, want first value %#v", result.Rows, test.wantValue)
			}

			queries, execs := recordedXuguShowStatements()
			if !equalStrings(queries, []string{test.wantQuery}) {
				t.Fatalf("queries = %v, want %v", queries, []string{test.wantQuery})
			}
			if len(execs) != 0 {
				t.Fatalf("query statements must not use ExecContext, got %v", execs)
			}
		})
	}
}

func TestIsQuerySQLRecognizesQueryKeywordBoundaries(t *testing.T) {
	for _, test := range []struct {
		sqlText string
		want    bool
	}{
		{sqlText: "SELECT 1", want: true},
		{sqlText: "SELECT(1)", want: true},
		{sqlText: "SELECT/*+ index */1", want: true},
		{sqlText: "WITH value AS (SELECT 1) SELECT * FROM value", want: true},
		{sqlText: "SHOW DB_INFO", want: true},
		{sqlText: "  show current_schema", want: true},
		{sqlText: "/* Xugu metadata */ SHOW CHARSETS", want: true},
		{sqlText: "SHOW/* metadata */ DB_INFO", want: true},
		{sqlText: "-- leading comment\nSELECT(1)", want: true},
		{sqlText: "SELECTIVE settings", want: false},
		{sqlText: "SHOWCASE settings", want: false},
		{sqlText: "SHOW_CURRENT_SCHEMA", want: false},
		{sqlText: "CREATE TABLE items (id INTEGER)", want: false},
	} {
		t.Run(test.sqlText, func(t *testing.T) {
			if got := isQuerySQL(test.sqlText); got != test.want {
				t.Fatalf("isQuerySQL(%q) = %t, want %t", test.sqlText, got, test.want)
			}
		})
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

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

// -- fake drivers for agent tests --

func init() {
	sql.Register("xugu-test-blocking", &xuguBlockingDriver{})
	sql.Register("xugu-test-fast", &xuguFastDriver{})
	sql.Register("xugu-test-recording", &xuguRecordingDriver{})
	sql.Register("xugu-test-legacy-columns", &xuguLegacyColumnsDriver{})
	sql.Register("xugu-test-table-objects", &xuguTableObjectsDriver{})
	sql.Register("xugu-test-table-ddl", &xuguTableDDLDriver{})
	sql.Register("xugu-test-show-result", &xuguShowResultDriver{})
	sql.Register("xugu-test-sequence-source", &xuguSequenceSourceDriver{})
}

type xuguShowResultDriver struct{}

var xuguShowResultState struct {
	sync.Mutex
	queries []string
	execs   []string
}

func resetXuguShowResultDriver() {
	xuguShowResultState.Lock()
	xuguShowResultState.queries = nil
	xuguShowResultState.execs = nil
	xuguShowResultState.Unlock()
}

func recordedXuguShowStatements() (queries []string, execs []string) {
	xuguShowResultState.Lock()
	defer xuguShowResultState.Unlock()
	return append([]string(nil), xuguShowResultState.queries...), append([]string(nil), xuguShowResultState.execs...)
}

func (d *xuguShowResultDriver) Open(name string) (driver.Conn, error) {
	return &xuguShowResultConn{}, nil
}

type xuguShowResultConn struct{}

func (c *xuguShowResultConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("not supported")
}
func (c *xuguShowResultConn) Close() error              { return nil }
func (c *xuguShowResultConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }
func (c *xuguShowResultConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	xuguShowResultState.Lock()
	xuguShowResultState.queries = append(xuguShowResultState.queries, query)
	xuguShowResultState.Unlock()

	switch query {
	case "SELECT(1)", "SELECT/*+ index */1":
		return &xuguStaticRows{columns: []string{"VALUE"}, values: [][]driver.Value{{int64(1)}}}, nil
	case "SHOW DB_INFO", "SHOW/* metadata */ DB_INFO":
		return &xuguStaticRows{
			columns: []string{"DB_NAME", "DB_ID", "DB_OWNER", "DB_CHARSET", "DB_TIMEZ"},
			values:  [][]driver.Value{{"SYSTEM", int64(1), "SYS", "UTF8.UTF8_GENERAL_CI", "GMT+08:00"}},
		}, nil
	default:
		return nil, fmt.Errorf("unexpected query: %s", query)
	}
}
func (c *xuguShowResultConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	xuguShowResultState.Lock()
	xuguShowResultState.execs = append(xuguShowResultState.execs, query)
	xuguShowResultState.Unlock()
	return nil, fmt.Errorf("SHOW statement was incorrectly sent to ExecContext: %s", query)
}

type xuguSequenceSourceDriver struct{}

func (d *xuguSequenceSourceDriver) Open(name string) (driver.Conn, error) {
	return &xuguSequenceSourceConn{}, nil
}

type xuguSequenceSourceConn struct{}

func (c *xuguSequenceSourceConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("not supported")
}
func (c *xuguSequenceSourceConn) Close() error              { return nil }
func (c *xuguSequenceSourceConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }
func (c *xuguSequenceSourceConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	upper := strings.ToUpper(query)
	if !strings.Contains(upper, "FROM ALL_SEQUENCES") || !strings.Contains(upper, "Q.IS_SYS = FALSE") {
		return nil, fmt.Errorf("unexpected sequence source query: %s", query)
	}
	if strings.Contains(upper, "Q.CURR_VAL") {
		if strings.Contains(upper, "UPPER(") || !strings.Contains(query, "s.SCHEMA_NAME = 'AppSchema'") || !strings.Contains(query, "q.SEQ_NAME = 'seqOrderNo'") {
			return nil, fmt.Errorf("sequence metadata must use exact catalog identifiers: %s", query)
		}
		return &xuguStaticRows{
			columns: []string{"SCHEMA_NAME", "SEQ_NAME", "CURR_VAL", "MIN_VAL", "MAX_VAL", "STEP_VAL", "CACHE_VAL", "IS_CYCLE", "COMMENTS"},
			values:  [][]driver.Value{{"AppSchema", "seqOrderNo", int64(500), int64(-100), int64(10000), int64(10), int64(20), true, "order's next number"}},
		}, nil
	}
	if strings.Contains(upper, "SELECT S.SCHEMA_NAME, Q.SEQ_NAME") {
		if strings.Contains(upper, "UPPER(") || !strings.Contains(query, "s.SCHEMA_NAME = 'AppSchema'") || !strings.Contains(query, "q.SEQ_NAME = 'seqOrderNo'") {
			return nil, fmt.Errorf("sequence resolution must prioritize exact catalog identifiers: %s", query)
		}
		return &xuguStaticRows{
			columns: []string{"SCHEMA_NAME", "SEQ_NAME"},
			values:  [][]driver.Value{{"AppSchema", "seqOrderNo"}},
		}, nil
	}
	return &xuguStaticRows{
		columns: []string{"SCHEMA_NAME", "SEQ_NAME"},
	}, nil
}

type xuguTableDDLDriver struct{}

func (d *xuguTableDDLDriver) Open(name string) (driver.Conn, error) {
	return &xuguTableDDLConn{}, nil
}

type xuguTableDDLConn struct{}

func (c *xuguTableDDLConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("not supported")
}
func (c *xuguTableDDLConn) Close() error              { return nil }
func (c *xuguTableDDLConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }
func (c *xuguTableDDLConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	upper := strings.ToUpper(query)
	constraintColumns := []string{"CONS_NAME", "CONS_TYPE", "DEFINE", "SCHEMA_NAME", "TABLE_NAME", "MATCH_TYPE", "UPDATE_ACTION", "DELETE_ACTION", "DEFERRABLE", "INITDEFERRED", "ENABLE", "VALID", "IS_SYS"}
	switch {
	case strings.Contains(upper, "SELECT S.SCHEMA_NAME, T.TABLE_NAME") && strings.Contains(upper, "FROM ALL_TABLES"):
		return &xuguStaticRows{columns: []string{"SCHEMA_NAME", "TABLE_NAME"}, values: [][]driver.Value{{"APP", "CHILD"}}}, nil
	case strings.Contains(upper, "C.CONS_TYPE = 'P'"):
		return &xuguStaticRows{columns: []string{"DEFINE"}, values: [][]driver.Value{{`"ID"`}}}, nil
	case strings.Contains(upper, "C.CONS_TYPE <> 'F'"):
		return &xuguStaticRows{columns: constraintColumns, values: [][]driver.Value{
			{"PK_CHILD", "P", `"ID"`, nil, nil, nil, nil, nil, false, false, true, true, false},
			{"UK_CHILD_ID", "U", `"ID"`, nil, nil, nil, nil, nil, false, false, true, true, false},
			{"UK_SYS_ID", "U", `"ID"`, nil, nil, nil, nil, nil, false, false, true, true, true},
		}}, nil
	case strings.Contains(upper, "C.CONS_TYPE = 'F'"):
		return &xuguStaticRows{columns: constraintColumns, values: [][]driver.Value{{"FK_CHILD_PARENT", "F", `("PARENT_ID")("ID")`, "APP", "PARENT", "U", "n", "c", false, false, true, true, false}}}, nil
	case strings.Contains(upper, "C.IS_SERIAL"):
		return &xuguStaticRows{
			columns: []string{"COL_NAME", "MIN_VAL", "STEP_VAL", "IS_SYS"},
			values:  [][]driver.Value{{"ID", int64(1), int64(1), true}},
		}, nil
	case strings.Contains(upper, "FROM ALL_COLUMNS"):
		return &xuguStaticRows{
			columns: []string{"COL_NAME", "TYPE_NAME", "NOT_NULL", "DEF_VAL", "ON_NULL", "COMMENTS", "SCALE", "VARYING"},
			values: [][]driver.Value{
				{"ID", "INTEGER", true, nil, int64(0), nil, int64(-1), false},
				{"PARENT_ID", "INTEGER", false, nil, int64(0), nil, int64(-1), false},
			},
		}, nil
	case strings.Contains(upper, "T.TEMP_TYPE"):
		return &xuguStaticRows{
			columns: []string{"TEMP_TYPE", "ON_COMMIT_DEL", "PCTFREE", "COPY_NUM", "PARTI_TYPE", "PARTI_NUM", "PARTI_KEY", "AUTO_PARTI_TYPE", "AUTO_PARTI_SPAN", "SUBPARTI_TYPE", "SUBPARTI_NUM", "SUBPARTI_KEY", "COMMENTS"},
			values:  [][]driver.Value{{int64(0), false, int64(0), int64(0), int64(0), int64(0), nil, int64(0), int64(0), int64(0), int64(0), nil, nil}},
		}, nil
	case strings.Contains(upper, "FROM ALL_PARTIS"):
		return &xuguStaticRows{columns: []string{"PARTI_NO", "PARTI_NAME", "PARTI_VAL", "ONLINE", "PARTI_TYPE", "PARTI_KEY", "AUTO_PARTI_TYPE", "AUTO_PARTI_SPAN"}}, nil
	case strings.Contains(upper, "FROM ALL_SUBPARTIS"):
		return &xuguStaticRows{columns: []string{"SUBPARTI_NO", "SUBPARTI_NAME", "SUBPARTI_VAL", "SUBPARTI_TYPE", "SUBPARTI_KEY"}}, nil
	default:
		return nil, fmt.Errorf("unexpected DDL catalog query: %s", query)
	}
}

type xuguRecordingDriver struct{}

var xuguRecordingState struct {
	sync.Mutex
	sql string
}

func resetXuguRecordingDriver() {
	xuguRecordingState.Lock()
	xuguRecordingState.sql = ""
	xuguRecordingState.Unlock()
}

func recordedXuguSQL() string {
	xuguRecordingState.Lock()
	defer xuguRecordingState.Unlock()
	return xuguRecordingState.sql
}

func (d *xuguRecordingDriver) Open(name string) (driver.Conn, error) {
	return &xuguRecordingConn{}, nil
}

type xuguRecordingConn struct{}

func (c *xuguRecordingConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("not supported")
}
func (c *xuguRecordingConn) Close() error              { return nil }
func (c *xuguRecordingConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }
func (c *xuguRecordingConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	xuguRecordingState.Lock()
	xuguRecordingState.sql = query
	xuguRecordingState.Unlock()
	return driver.ResultNoRows, nil
}

type xuguTableObjectsDriver struct{}

func (d *xuguTableObjectsDriver) Open(name string) (driver.Conn, error) {
	return &xuguTableObjectsConn{}, nil
}

type xuguTableObjectsConn struct{}

func (c *xuguTableObjectsConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("not supported")
}
func (c *xuguTableObjectsConn) Close() error              { return nil }
func (c *xuguTableObjectsConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }
func (c *xuguTableObjectsConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	switch upper := strings.ToUpper(query); {
	case strings.Contains(upper, "FROM ALL_CONSTRAINTS"):
		if !strings.Contains(upper, "C.CONS_TYPE <> 'F'") {
			return nil, errors.New("generic constraints query must exclude foreign keys")
		}
		return &xuguStaticRows{
			columns: []string{"CONS_NAME", "CONS_TYPE", "DEFINE", "SCHEMA_NAME", "TABLE_NAME", "MATCH_TYPE", "UPDATE_ACTION", "DELETE_ACTION", "DEFERRABLE", "INITDEFERRED", "ENABLE", "VALID", "IS_SYS"},
			values:  [][]driver.Value{{"PK_ORDERS", "P", `("ORDER_ID")`, nil, nil, nil, nil, nil, false, false, true, true, false}},
		}, nil
	case strings.Contains(upper, "FROM ALL_PARTIS"):
		return &xuguStaticRows{
			columns: []string{"PARTI_NO", "PARTI_NAME", "PARTI_VAL", "ONLINE", "PARTI_TYPE", "PARTI_KEY", "AUTO_PARTI_TYPE", "AUTO_PARTI_SPAN"},
			values:  [][]driver.Value{{int64(1), "P_2025", "'2026-01-01'", true, int64(1), `"ORDER_TIME"`, int64(0), int64(0)}},
		}, nil
	case strings.Contains(upper, "FROM ALL_SUBPARTIS"):
		return &xuguStaticRows{
			columns: []string{"SUBPARTI_NO", "SUBPARTI_NAME", "SUBPARTI_VAL", "SUBPARTI_TYPE", "SUBPARTI_KEY"},
			values:  [][]driver.Value{{int64(1), "SP_PENDING", "'10'", int64(2), `"ORDER_STATUS"`}},
		}, nil
	default:
		return nil, fmt.Errorf("unexpected query: %s", query)
	}
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
	case strings.Contains(upper, "SELECT S.SCHEMA_NAME, T.TABLE_NAME") && strings.Contains(upper, "FROM ALL_TABLES"):
		return &xuguStaticRows{columns: []string{"SCHEMA_NAME", "TABLE_NAME"}, values: [][]driver.Value{{"SYSDBA", "PRODUCTS"}}}, nil
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
