package main

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
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

func TestMissingTableReadSessionMethodsReturnEmptyOrFalse(t *testing.T) {
	s := newServer()

	fetchResp, shutdown := s.handleLine(`{"jsonrpc":"2.0","id":9,"method":"fetch_table_read_page","params":{"sessionId":"missing","pageSize":10}}`)
	if shutdown {
		t.Fatal("fetch_table_read_page should not shut down the server")
	}
	if fetchResp.Error != nil {
		t.Fatalf("unexpected fetch error: %v", fetchResp.Error)
	}
	data, err := json.Marshal(fetchResp.Result)
	if err != nil {
		t.Fatal(err)
	}
	var page queryPageResult
	if err := json.Unmarshal(data, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Columns) != 0 || len(page.Rows) != 0 || page.HasMore || page.SessionID != nil {
		t.Fatalf("missing table read session should return empty page, got %+v", page)
	}

	closeResp, shutdown := s.handleLine(`{"jsonrpc":"2.0","id":10,"method":"close_table_read_session","params":{"sessionId":"missing"}}`)
	if shutdown {
		t.Fatal("close_table_read_session should not shut down the server")
	}
	if closeResp.Error != nil {
		t.Fatalf("unexpected close error: %v", closeResp.Error)
	}
	if closeResp.Result != false {
		t.Fatalf("expected false result, got %#v", closeResp.Result)
	}
}

func TestEmptyResultSlicesMarshalAsArrays(t *testing.T) {
	data, err := json.Marshal(queryResult{})
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, `"columns":null`) || strings.Contains(text, `"rows":null`) {
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
	data, err := json.Marshal("CREATE TABLE HR.ORDERS (ID NUMBER)")
	if err != nil {
		t.Fatal(err)
	}
	var ddl string
	if err := json.Unmarshal(data, &ddl); err != nil {
		t.Fatalf("get_table_ddl result must deserialize as a string: %v", err)
	}
}

func TestNormalizeDDLObjectType(t *testing.T) {
	tests := map[string]string{
		"":                  "",
		"table":             "TABLE",
		"VIEW":              "VIEW",
		"materialized view": "MATERIALIZED_VIEW",
		"MATERIALIZED_VIEW": "MATERIALIZED_VIEW",
		"procedure":         "",
	}
	for input, want := range tests {
		if got := normalizeDDLObjectType(input); got != want {
			t.Fatalf("normalizeDDLObjectType(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestIsQuerySQLSkipsLeadingComments(t *testing.T) {
	tests := []string{
		"-- 测试\nSELECT * FROM (SELECT * FROM \"DBX_TEST\".\"ORDERS_10K\") WHERE ROWNUM <= 100",
		"/* explain */\nSELECT * FROM dual",
		"-- comment\r\nWITH rows AS (SELECT 1 FROM dual) SELECT * FROM rows",
	}
	for _, sqlText := range tests {
		if !isQuerySQL(sqlText) {
			t.Fatalf("expected SQL to be treated as query: %s", sqlText)
		}
	}
}

func TestIsQuerySQLRequiresKeywordBoundary(t *testing.T) {
	tests := []string{
		"-- comment only",
		"selectivity FROM stats",
		"withdraw FROM account",
		"/* unterminated comment",
	}
	for _, sqlText := range tests {
		if isQuerySQL(sqlText) {
			t.Fatalf("expected SQL not to be treated as query: %s", sqlText)
		}
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

func TestOracleColumnTypeDDL(t *testing.T) {
	charLen := 64
	precision := 10
	scale := 2
	zeroScale := 0

	tests := []struct {
		name   string
		column columnInfo
		want   string
	}{
		{name: "varchar", column: columnInfo{DataType: "VARCHAR2", CharacterMaximumLength: &charLen}, want: "VARCHAR2(64)"},
		{name: "number scale", column: columnInfo{DataType: "NUMBER", NumericPrecision: &precision, NumericScale: &scale}, want: "NUMBER(10,2)"},
		{name: "number zero scale", column: columnInfo{DataType: "NUMBER", NumericPrecision: &precision, NumericScale: &zeroScale}, want: "NUMBER(10)"},
		{name: "timestamp preserves precision", column: columnInfo{DataType: "TIMESTAMP(6)"}, want: "TIMESTAMP(6)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := oracleColumnTypeDDL(tt.column); got != tt.want {
				t.Fatalf("oracleColumnTypeDDL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBuildDSNUsesConnectionStringWhenProvided(t *testing.T) {
	dsn := buildDSN(connectParams{ConnectionString: "oracle://scott:tiger@db.example.com:1521/ORCLPDB1"})

	if dsn != "oracle://scott:tiger@db.example.com:1521/ORCLPDB1" {
		t.Fatalf("unexpected dsn: %s", dsn)
	}
}

func TestBuildDSNUsesJdbcServiceHostAndPort(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:             "127.0.0.1",
		Port:             11521,
		Database:         "ORCLPDB1",
		Username:         "scott",
		Password:         "tiger",
		ConnectionString: "jdbc:oracle:thin:@//oracle.example.com:1521/ORCLPDB1",
	})

	if strings.Contains(strings.ToLower(dsn), "jdbc:") {
		t.Fatalf("dsn should be go-ora format, got: %s", dsn)
	}
	if !strings.Contains(dsn, "oracle.example.com:1521") || !strings.Contains(dsn, "ORCLPDB1") {
		t.Fatalf("dsn should use JDBC host/port/database fields, got: %s", dsn)
	}
}

func TestBuildDSNUsesRewrittenJdbcServiceHostAndPort(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:             "127.0.0.1",
		Port:             11521,
		Database:         "ORCLPDB1",
		Username:         "scott",
		Password:         "tiger",
		ConnectionString: "jdbc:oracle:thin:@//127.0.0.1:11521/ORCLPDB1",
	})

	if strings.Contains(strings.ToLower(dsn), "jdbc:") {
		t.Fatalf("dsn should be go-ora format, got: %s", dsn)
	}
	if !strings.Contains(dsn, "127.0.0.1:11521") || !strings.Contains(dsn, "ORCLPDB1") {
		t.Fatalf("dsn should use rewritten JDBC host/port/database fields, got: %s", dsn)
	}
}

func TestBuildDSNConvertsJdbcSID(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:             "127.0.0.1",
		Port:             11521,
		Database:         "ORCL",
		Username:         "scott",
		Password:         "tiger",
		ConnectionString: "jdbc:oracle:thin:@oracle.example.com:1521:ORCL",
	})

	if strings.Contains(strings.ToLower(dsn), "jdbc:") {
		t.Fatalf("dsn should be go-ora format, got: %s", dsn)
	}
	upperDSN := strings.ToUpper(dsn)
	if !strings.Contains(dsn, "oracle.example.com:1521") || !strings.Contains(upperDSN, "SID=ORCL") {
		t.Fatalf("dsn should use JDBC host/port and SID option, got: %s", dsn)
	}
}

func TestBuildDSNConvertsJdbcDescriptor(t *testing.T) {
	dsn := buildDSN(connectParams{
		Username:         "scott",
		Password:         "tiger",
		ConnectionString: "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db.example.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCLPDB1)))",
	})

	if !strings.HasPrefix(dsn, "oracle://scott:tiger@") {
		t.Fatalf("descriptor should become go-ora url, got: %s", dsn)
	}
	if !strings.Contains(dsn, "connStr=") {
		t.Fatalf("descriptor should be passed via connStr option, got: %s", dsn)
	}
}

func TestBuildDSNAddsSysDbaOption(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:      "127.0.0.1",
		Port:      1521,
		Database:  "SYSDBA:ORCLPDB1",
		Username:  "sys",
		Password:  "secret",
		SysDBA:    true,
		URLParams: "TRACE FILE=trace.log",
	})

	if strings.Contains(dsn, "SYSDBA:") {
		t.Fatalf("dsn should strip SYSDBA prefix: %s", dsn)
	}
	if !strings.Contains(dsn, "ORCLPDB1") {
		t.Fatalf("dsn should include service name: %s", dsn)
	}
	upperDSN := strings.ToUpper(dsn)
	if !strings.Contains(upperDSN, "AUTH TYPE=SYSDBA") &&
		!strings.Contains(upperDSN, "AUTH+TYPE=SYSDBA") &&
		!strings.Contains(upperDSN, "AUTH%20TYPE=SYSDBA") {
		t.Fatalf("dsn should include SYSDBA auth option: %s", dsn)
	}
}

func TestListDatabasesSQLUsesUserDictionaryInsteadOfObjectDictionary(t *testing.T) {
	sqlText := strings.ToUpper(oracleListDatabasesSQL)

	if !strings.Contains(sqlText, "ALL_USERS") {
		t.Fatalf("schema listing should query ALL_USERS, got: %s", oracleListDatabasesSQL)
	}
	if strings.Contains(sqlText, "ALL_TABLES") || strings.Contains(sqlText, "ALL_VIEWS") {
		t.Fatalf("schema listing should not scan object dictionaries, got: %s", oracleListDatabasesSQL)
	}
}

func TestListDatabasesSQLCanApplyVisibleSchemaFilter(t *testing.T) {
	sqlText, args := oracleListDatabasesSQLWithVisibleSchemas([]string{"APP", "REPORTING"})
	upperSQL := strings.ToUpper(sqlText)

	if !strings.Contains(upperSQL, "ALL_USERS") {
		t.Fatalf("schema listing should query ALL_USERS, got: %s", sqlText)
	}
	if !strings.Contains(upperSQL, "USERNAME IN (:1,:2)") {
		t.Fatalf("schema listing should apply visible schema filter, got: %s", sqlText)
	}
	if len(args) != 2 || args[0] != "APP" || args[1] != "REPORTING" {
		t.Fatalf("visible schema args were not preserved: %#v", args)
	}
	if strings.Contains(upperSQL, "ALL_TABLES") || strings.Contains(upperSQL, "ALL_VIEWS") {
		t.Fatalf("schema listing should not scan object dictionaries, got: %s", sqlText)
	}
}

func TestListTablesSQLUsesSplitDictionaryQuery(t *testing.T) {
	sqlText := strings.ToUpper(oracleListTablesSQL)

	if !strings.Contains(sqlText, "ALL_TABLES") || !strings.Contains(sqlText, "ALL_OBJECTS") {
		t.Fatalf("table listing should split tables and views, got: %s", oracleListTablesSQL)
	}
	if !strings.Contains(sqlText, "UNION ALL") {
		t.Fatalf("table listing should union table and view metadata, got: %s", oracleListTablesSQL)
	}
	if strings.Contains(sqlText, "ALL_TAB_COMMENTS") {
		t.Fatalf("table listing should not load comments during refresh, got: %s", oracleListTablesSQL)
	}
}

func TestListObjectsSQLUsesSplitDictionaryQuery(t *testing.T) {
	sqlText := strings.ToUpper(oracleListObjectsSQL)

	if !strings.Contains(sqlText, "ALL_TABLES") || !strings.Contains(sqlText, "ALL_OBJECTS") {
		t.Fatalf("object listing should split tables from other objects, got: %s", oracleListObjectsSQL)
	}
	if !strings.Contains(sqlText, "UNION ALL") {
		t.Fatalf("object listing should union object metadata, got: %s", oracleListObjectsSQL)
	}
	if strings.Contains(sqlText, "ALL_TAB_COMMENTS") {
		t.Fatalf("object listing should not load comments during refresh, got: %s", oracleListObjectsSQL)
	}
}

func TestIsOraclePGALimitError(t *testing.T) {
	if !isOraclePGALimitError(errors.New("ORA-04036: PGA memory used by the instance exceeds PGA_AGGREGATE_LIMIT")) {
		t.Fatal("expected ORA-04036 to be detected")
	}
	if isOraclePGALimitError(errors.New("ORA-00942: table or view does not exist")) {
		t.Fatal("unexpected ORA-00942 match")
	}
}

func TestRewriteOracleXMLTypeSelectStar(t *testing.T) {
	sqlText, err := rewriteOracleXMLTypeSelectSQL(
		`SELECT * FROM TEST_LOBS`,
		fakeOracleColumnLoader([]oracleColumnMeta{
			{Name: "ID", DataType: "NUMBER"},
			{Name: "XML_CONTENT", DataType: "XMLTYPE"},
			{Name: "TEST_NAME", DataType: "VARCHAR2"},
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := `SELECT "ID", XMLSERIALIZE(CONTENT "XML_CONTENT" AS CLOB) AS "XML_CONTENT", "TEST_NAME" FROM TEST_LOBS`
	if sqlText != want {
		t.Fatalf("rewriteOracleXMLTypeSelectSQL() = %s, want %s", sqlText, want)
	}
}

func TestRewriteOracleXMLTypeExplicitColumn(t *testing.T) {
	sqlText, err := rewriteOracleXMLTypeSelectSQL(
		`SELECT t.ID, t.XML_CONTENT AS xml_doc FROM TEST_LOBS t WHERE t.ID = 1`,
		fakeOracleColumnLoader([]oracleColumnMeta{
			{Name: "ID", DataType: "NUMBER"},
			{Name: "XML_CONTENT", DataType: "SYS.XMLTYPE"},
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := `SELECT t.ID, XMLSERIALIZE(CONTENT t."XML_CONTENT" AS CLOB) AS xml_doc FROM TEST_LOBS t WHERE t.ID = 1`
	if sqlText != want {
		t.Fatalf("rewriteOracleXMLTypeSelectSQL() = %s, want %s", sqlText, want)
	}
}

func TestRewriteOracleXMLTypeNestedRownumQuery(t *testing.T) {
	sqlText, err := rewriteOracleXMLTypeSelectSQL(
		`SELECT * FROM (SELECT "ID", "XML_CONTENT" FROM "DBX"."TEST_LOBS") WHERE ROWNUM <= 100`,
		fakeOracleColumnLoader([]oracleColumnMeta{
			{Name: "ID", DataType: "NUMBER"},
			{Name: "XML_CONTENT", DataType: "XMLTYPE"},
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sqlText, `XMLSERIALIZE(CONTENT "XML_CONTENT" AS CLOB) AS "XML_CONTENT"`) {
		t.Fatalf("expected nested XMLTYPE column to be serialized, got: %s", sqlText)
	}
}

func TestRewriteOracleXMLTypeSkipsJoins(t *testing.T) {
	called := false
	sqlText, err := rewriteOracleXMLTypeSelectSQL(
		`SELECT * FROM TEST_LOBS l JOIN OTHER_TABLE o ON o.ID = l.ID`,
		func(schema, table string) ([]oracleColumnMeta, error) {
			called = true
			return nil, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("join query should not load table metadata")
	}
	if sqlText != `SELECT * FROM TEST_LOBS l JOIN OTHER_TABLE o ON o.ID = l.ID` {
		t.Fatalf("join query should not be rewritten, got: %s", sqlText)
	}
}

func fakeOracleColumnLoader(columns []oracleColumnMeta) oracleColumnMetaLoader {
	return func(schema, table string) ([]oracleColumnMeta, error) {
		if strings.ToUpper(table) != "TEST_LOBS" {
			return nil, nil
		}
		return columns, nil
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
