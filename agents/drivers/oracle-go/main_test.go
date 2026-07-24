package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"reflect"
	"strings"
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
	resp, shutdown := runtime.handleLine(`{"jsonrpc":"2.0","id":7,"method":"handshake","params":{"appVersion":"dev"}}`)
	if shutdown || resp.Error != nil {
		t.Fatalf("unexpected handshake response: shutdown=%v error=%v", shutdown, resp.Error)
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
	if result.ProtocolVersion != 2 || result.AgentProtocolVersion != 2 {
		t.Fatalf("unexpected protocol versions: %+v", result)
	}
	if !contains(result.Capabilities, "multi_session") {
		t.Fatalf("expected multi_session capability, got %v", result.Capabilities)
	}
}

func TestRuntimeMissingAgentSessionDoesNotUseQueryCursorSessionID(t *testing.T) {
	runtime := newRuntimeServer()
	resp, shutdown := runtime.handleLine(`{"jsonrpc":"2.0","id":8,"method":"fetch_query_page","params":{"sessionId":"cursor-1","pageSize":10}}`)
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
	if len(page.Columns) != 0 || len(page.ColumnTypes) != 0 || len(page.Rows) != 0 || page.HasMore || page.SessionID != nil {
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
	if strings.Contains(text, `"columns":null`) || strings.Contains(text, `"column_types":null`) || strings.Contains(text, `"rows":null`) {
		t.Fatalf("query result should marshal nil slices as arrays: %s", text)
	}
	if !strings.Contains(text, `"column_types":[]`) {
		t.Fatalf("query result should marshal empty column types array: %s", text)
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

func TestNormalizeValueFormatsOracleBinaryColumnsAsHex(t *testing.T) {
	tests := map[string]string{
		"RAW":            "0x000f10ff",
		"raw":            "0x000f10ff",
		"LongRaw":        "0x000f10ff",
		"LONG RAW":       "0x000f10ff",
		"LongVarRaw":     "0x000f10ff",
		"OCIBlobLocator": "0x000f10ff",
	}

	for columnType, want := range tests {
		if got := normalizeValue([]byte{0x00, 0x0f, 0x10, 0xff}, columnType); got != want {
			t.Fatalf("normalizeValue RAW bytes for %q = %#v, want %q", columnType, got, want)
		}
	}
}

func TestNormalizeValueKeepsNonBinaryBytesAsText(t *testing.T) {
	if got := normalizeValue([]byte("hello"), "VARCHAR2"); got != "hello" {
		t.Fatalf("normalizeValue text bytes = %#v, want %q", got, "hello")
	}
	if got := normalizeValue([]byte("legacy"), ""); got != "legacy" {
		t.Fatalf("normalizeValue bytes without metadata = %#v, want %q", got, "legacy")
	}
}

func TestNormalizeValueFormatsOracleTimezoneLessDateTimesAsWallClock(t *testing.T) {
	value := time.Date(2026, time.July, 23, 13, 42, 13, 123456000, time.FixedZone("CST", 8*60*60))
	tests := []string{
		"DATE",
		"TIMESTAMP",
		"TIMESTAMP(6)",
		"TimeStampDTY",
	}

	for _, columnType := range tests {
		if got := normalizeValue(value, columnType); got != "2026-07-23T13:42:13.123456" {
			t.Fatalf("normalizeValue time for %q = %#v, want wall-clock value", columnType, got)
		}
	}
}

func TestNormalizeValueKeepsOracleZonedDateTimeOffsets(t *testing.T) {
	value := time.Date(2026, time.July, 23, 13, 42, 13, 123456000, time.FixedZone("CST", 8*60*60))
	tests := []string{
		"TimeStampTZ_DTY",
		"TIMESTAMP WITH TIME ZONE",
	}

	for _, columnType := range tests {
		if got := normalizeValue(value, columnType); got != "2026-07-23T13:42:13.123456+08:00" {
			t.Fatalf("normalizeValue time for %q = %#v, want RFC3339 offset", columnType, got)
		}
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

func TestTrimStatementSQLPreservesAnonymousPLSQLBlockTerminator(t *testing.T) {
	sqlText := `DECLARE
   PRE_TRD_DATE   INTEGER ;
BEGIN
   SELECT 1 + 2 INTO PRE_TRD_DATE FROM DUAL;
END;`

	if got := trimStatementSQL(sqlText); got != sqlText {
		t.Fatalf("trimStatementSQL() = %q, want full PL/SQL block %q", got, sqlText)
	}
}

func TestTrimStatementSQLStripsSlashDelimiterAfterPLSQLBlock(t *testing.T) {
	sqlText := "BEGIN\n  NULL;\nEND;\n/"
	want := "BEGIN\n  NULL;\nEND;"

	if got := trimStatementSQL(sqlText); got != want {
		t.Fatalf("trimStatementSQL() = %q, want %q", got, want)
	}
}

func TestTrimStatementSQLPreservesCreatePLSQLObjectTerminator(t *testing.T) {
	tests := []string{
		"CREATE OR REPLACE PROCEDURE p AS\nBEGIN\n  NULL;\nEND;",
		"CREATE OR REPLACE FUNCTION f RETURN NUMBER AS\nBEGIN\n  RETURN 1;\nEND;",
		"CREATE OR REPLACE PACKAGE pkg_utils AS\n  FUNCTION get_version RETURN VARCHAR2;\nEND pkg_utils;",
	}
	for _, sqlText := range tests {
		if got := trimStatementSQL(sqlText); got != sqlText {
			t.Fatalf("trimStatementSQL() = %q, want full PL/SQL object %q", got, sqlText)
		}
	}
}

func TestTrimStatementSQLStripsSlashDelimiterAfterCreatePLSQLObject(t *testing.T) {
	sqlText := "CREATE OR REPLACE PROCEDURE p AS\nBEGIN\n  NULL;\nEND;\n/"
	want := "CREATE OR REPLACE PROCEDURE p AS\nBEGIN\n  NULL;\nEND;"

	if got := trimStatementSQL(sqlText); got != want {
		t.Fatalf("trimStatementSQL() = %q, want %q", got, want)
	}
}

func TestTrimStatementSQLRemovesRegularStatementSemicolon(t *testing.T) {
	if got := trimStatementSQL("SELECT 1 FROM DUAL;"); got != "SELECT 1 FROM DUAL" {
		t.Fatalf("trimStatementSQL() = %q, want regular statement without semicolon", got)
	}
}

func TestOracleExplainPlanBindParamsIncludesNamedParameters(t *testing.T) {
	sqlText := `
SELECT *
FROM orders
WHERE id = :id
  AND status = :status
  AND parent_id = :id`

	want := []oracleBindParam{
		{Name: "id"},
		{Name: "status"},
	}
	if got := oracleExplainPlanBindParams(sqlText); !reflect.DeepEqual(got, want) {
		t.Fatalf("oracleExplainPlanBindParams() = %#v, want %#v", got, want)
	}
}

func TestOracleExplainPlanBindParamsSkipsQuotedTextAndComments(t *testing.T) {
	sqlText := `
SELECT ':literal' AS literal_value,
       q'[not :q_param]' AS q_literal,
       "COL:NAME" AS quoted_identifier
FROM orders
WHERE id = :id
  -- ignored :comment_param
  AND note <> 'escaped '' :text_param'
  /* ignored :block_param */`

	want := []oracleBindParam{{Name: "id"}}
	if got := oracleExplainPlanBindParams(sqlText); !reflect.DeepEqual(got, want) {
		t.Fatalf("oracleExplainPlanBindParams() = %#v, want %#v", got, want)
	}
}

func TestOracleExplainPlanBindParamsIncludesPositionalParameters(t *testing.T) {
	sqlText := "SELECT * FROM orders WHERE id = :1 AND status = :status"

	want := []oracleBindParam{
		{Name: "1", Positional: true},
		{Name: "status"},
	}
	if got := oracleExplainPlanBindParams(sqlText); !reflect.DeepEqual(got, want) {
		t.Fatalf("oracleExplainPlanBindParams() = %#v, want %#v", got, want)
	}
}

func TestOracleExplainPlanBindArgsUsesNamedArguments(t *testing.T) {
	args := oracleExplainPlanBindArgs("SELECT * FROM orders WHERE id = :id")

	if len(args) != 1 {
		t.Fatalf("expected one bind argument, got %#v", args)
	}
	named, ok := args[0].(sql.NamedArg)
	if !ok {
		t.Fatalf("expected sql.NamedArg, got %#v", args[0])
	}
	if named.Name != "id" || named.Value != nil {
		t.Fatalf("unexpected named bind argument: %#v", named)
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

func TestBuildDSNPreservesBastionUsernameAndEncodesCredentials(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:     "db.example.com",
		Port:     1521,
		Database: "XE",
		Username: "9008888:reader",
		Password: "dbx:pass",
	})

	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	password, _ := parsed.User.Password()
	if parsed.User.Username() != "9008888:reader" || password != "dbx:pass" {
		t.Fatalf("credentials should survive URL parsing, dsn=%s username=%q password=%q", dsn, parsed.User.Username(), password)
	}
	if !strings.HasPrefix(parsed.User.String(), "9008888%3Areader:") {
		t.Fatalf("bastion username should be escaped without being quoted, dsn=%s", dsn)
	}
}

func TestBuildDSNEncodesColonInCredentialsFromJDBCServiceURL(t *testing.T) {
	dsn := buildDSN(connectParams{
		Username:         "9008888:reader",
		Password:         "dbx:pass",
		ConnectionString: "jdbc:oracle:thin:@//db.example.com:1521/XE",
	})

	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	password, _ := parsed.User.Password()
	if parsed.User.Username() != "9008888:reader" || password != "dbx:pass" {
		t.Fatalf("credentials should survive JDBC URL conversion, dsn=%s username=%q password=%q", dsn, parsed.User.Username(), password)
	}
	if parsed.Host != "db.example.com:1521" || strings.TrimPrefix(parsed.Path, "/") != "XE" {
		t.Fatalf("JDBC host/service should survive conversion, dsn=%s", dsn)
	}
}

func TestBuildDSNPreservesExplicitlyQuotedUsername(t *testing.T) {
	dsn := buildDSN(connectParams{
		Host:     "db.example.com",
		Port:     1521,
		Database: "XE",
		Username: `"abc:def"`,
		Password: "dbx:pass",
	})

	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.User.Username() != `"abc:def"` {
		t.Fatalf("explicitly quoted username should remain unchanged, dsn=%s username=%q", dsn, parsed.User.Username())
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

func TestOracleGB18030ConverterRoundTrip(t *testing.T) {
	converter := oracleGB18030Converter{}
	input := "DBX \u4e2d\u6587 \U00020000"

	encoded := converter.Encode(input)
	if string(encoded) == input {
		t.Fatalf("GB18030 converter should encode non-ASCII text away from UTF-8 bytes")
	}
	if decoded := converter.Decode(encoded); decoded != input {
		t.Fatalf("GB18030 round trip = %q, want %q", decoded, input)
	}
	if converter.GetLangID() != oracleCharsetZHS32GB18030 {
		t.Fatalf("GB18030 converter lang id = %d, want %d", converter.GetLangID(), oracleCharsetZHS32GB18030)
	}
	if clone := converter.Clone(); clone.GetLangID() != oracleCharsetZHS32GB18030 {
		t.Fatalf("GB18030 converter clone lang id = %d, want %d", clone.GetLangID(), oracleCharsetZHS32GB18030)
	}
}

func TestOracleStringConverterForUnsupportedCharsetError(t *testing.T) {
	err := errors.New("the server use charset with id: 854 which is not supported by the driver")
	converter, ok := oracleStringConverterForUnsupportedCharsetError(err)
	if !ok {
		t.Fatalf("expected GB18030 server charset error to have a converter")
	}
	if converter.GetLangID() != oracleCharsetZHS32GB18030 {
		t.Fatalf("converter lang id = %d, want %d", converter.GetLangID(), oracleCharsetZHS32GB18030)
	}
	ncharsetErr := errors.New("the server use ncharset with id: 854 which is not supported by the driver")
	if _, ok := oracleStringConverterForUnsupportedCharsetError(ncharsetErr); ok {
		t.Fatalf("ncharset errors should not have a server charset converter")
	}
	otherCharsetErr := errors.New("the server use charset with id: 852 which is not supported by the driver")
	if charsetID, ok := unsupportedOracleServerCharsetID(otherCharsetErr); !ok || charsetID != 852 {
		t.Fatalf("other server charset should still be parsed, got id=%d ok=%v", charsetID, ok)
	}
	if _, ok := oracleStringConverterForUnsupportedCharsetError(otherCharsetErr); ok {
		t.Fatalf("unknown charset ids should not get a guessed converter")
	}
}

func TestListDatabasesSQLUsesUserDictionaryInsteadOfObjectDictionary(t *testing.T) {
	sqlText := strings.ToUpper(oracleListDatabasesSQL)

	if !strings.Contains(sqlText, "ALL_USERS") {
		t.Fatalf("database listing should query ALL_USERS, got: %s", oracleListDatabasesSQL)
	}
	if strings.Contains(sqlText, "ALL_TABLES") || strings.Contains(sqlText, "ALL_VIEWS") {
		t.Fatalf("database listing should not scan object dictionaries, got: %s", oracleListDatabasesSQL)
	}
	if strings.Contains(sqlText, "'DIP'") {
		t.Fatalf("database listing should not hide an existing user named DIP, got: %s", oracleListDatabasesSQL)
	}
	if !strings.Contains(sqlText, "'SYS','SYSTEM'") || !strings.Contains(sqlText, "USERNAME NOT LIKE 'APEX_%'") {
		t.Fatalf("database listing should retain system schema filtering, got: %s", oracleListDatabasesSQL)
	}
}

func TestListDatabasesSQLCanApplyVisibleSchemaFilter(t *testing.T) {
	sqlText, args := oracleListDatabasesSQLWithVisibleSchemas([]string{"APP", "REPORTING"})
	upperSQL := strings.ToUpper(sqlText)

	if !strings.Contains(upperSQL, "ALL_USERS") {
		t.Fatalf("database listing should query ALL_USERS, got: %s", sqlText)
	}
	if !strings.Contains(upperSQL, "USERNAME IN (:1,:2)") {
		t.Fatalf("database listing should apply visible schema filter, got: %s", sqlText)
	}
	if len(args) != 2 || args[0] != "APP" || args[1] != "REPORTING" {
		t.Fatalf("visible schema args were not preserved: %#v", args)
	}
	if strings.Contains(upperSQL, "ALL_TABLES") || strings.Contains(upperSQL, "ALL_VIEWS") {
		t.Fatalf("database listing should not scan object dictionaries, got: %s", sqlText)
	}
	if !strings.Contains(upperSQL, "'SYS','SYSTEM'") {
		t.Fatalf("database visible-schema filtering should retain system exclusions, got: %s", sqlText)
	}
}

func TestListSchemasSQLIncludesSystemUsersWithoutSynthesizingPublic(t *testing.T) {
	sqlText := strings.ToUpper(oracleListSchemasSQL)

	if !strings.Contains(sqlText, "FROM ALL_USERS") {
		t.Fatalf("schema listing should query ALL_USERS, got: %s", oracleListSchemasSQL)
	}
	if strings.Contains(sqlText, "NOT IN") || strings.Contains(sqlText, "'SYS'") || strings.Contains(sqlText, "'SYSTEM'") {
		t.Fatalf("schema listing should not hard-exclude SYS or SYSTEM, got: %s", oracleListSchemasSQL)
	}
	if strings.Contains(sqlText, "PUBLIC") || strings.Contains(sqlText, "UNION") {
		t.Fatalf("schema listing should not synthesize PUBLIC, got: %s", oracleListSchemasSQL)
	}
	if !strings.Contains(sqlText, "CURRENT_SCHEMA') THEN 0") || !strings.Contains(sqlText, "SESSION_USER') THEN 1") {
		t.Fatalf("schema listing should prioritize CURRENT_SCHEMA then SESSION_USER, got: %s", oracleListSchemasSQL)
	}
}

func TestListSchemasSQLCanApplyVisibleSchemaFilter(t *testing.T) {
	sqlText, args := oracleListSchemasSQLWithVisibleSchemas([]string{"SYS", "SYSTEM"})
	upperSQL := strings.ToUpper(sqlText)

	if !strings.Contains(upperSQL, "USERNAME IN (:1,:2)") {
		t.Fatalf("schema listing should parameterize visible schemas, got: %s", sqlText)
	}
	if len(args) != 2 || args[0] != "SYS" || args[1] != "SYSTEM" {
		t.Fatalf("visible schema args were not preserved: %#v", args)
	}
	if strings.Contains(upperSQL, "NOT IN") || strings.Contains(upperSQL, "'SYS'") || strings.Contains(upperSQL, "'SYSTEM'") {
		t.Fatalf("visible schema query should not hard-exclude SYS or SYSTEM, got: %s", sqlText)
	}
	if !strings.Contains(upperSQL, "CURRENT_SCHEMA') THEN 0") || !strings.Contains(upperSQL, "SESSION_USER') THEN 1") {
		t.Fatalf("visible schema query should preserve schema ordering, got: %s", sqlText)
	}
}

func TestResolveOracleSchemaPrefersCurrentSchemaOverSessionUser(t *testing.T) {
	currentCalls := 0
	sessionUserCalls := 0
	schema, err := resolveOracleSchema(
		"",
		func() (string, error) {
			currentCalls++
			return "REPORTING", nil
		},
		func() (string, error) {
			sessionUserCalls++
			return "APP", nil
		},
	)

	if err != nil || schema != "REPORTING" {
		t.Fatalf("resolved schema = %q, err = %v; want REPORTING", schema, err)
	}
	if currentCalls != 1 || sessionUserCalls != 0 {
		t.Fatalf("unexpected resolver calls: current=%d session_user=%d", currentCalls, sessionUserCalls)
	}
}

func TestResolveOracleSchemaFallsBackToSessionUser(t *testing.T) {
	schema, err := resolveOracleSchema(
		"",
		func() (string, error) { return "", errors.New("CURRENT_SCHEMA unavailable") },
		func() (string, error) { return "APP", nil },
	)

	if err != nil || schema != "APP" {
		t.Fatalf("resolved schema = %q, err = %v; want APP", schema, err)
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

func TestListTablesQueryAppliesMetadataConstraints(t *testing.T) {
	query := oracleListTablesQuery("APP", metadataListConstraints{
		Filter:      "u_r",
		Limit:       501,
		Offset:      10,
		ObjectTypes: []string{"view", "TABLE", "TABLE"},
	})
	sqlText := strings.ToUpper(query.SQL)

	if !strings.Contains(sqlText, "UPPER(OBJECT_NAME) LIKE :3 ESCAPE '\\'") {
		t.Fatalf("table listing should push filter predicate, got: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "TABLE_TYPE IN (:4,:5)") {
		t.Fatalf("table listing should push table type predicate, got: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "ROWNUM <= :6") || !strings.Contains(sqlText, "DBX_RN > :7") {
		t.Fatalf("table listing should use rownum pagination, got: %s", query.SQL)
	}
	if len(query.Args) != 7 {
		t.Fatalf("unexpected args: %#v", query.Args)
	}
	if query.Args[0] != "APP" || query.Args[1] != "APP" || query.Args[2] != "%U%\\_%R%" || query.Args[3] != "TABLE" || query.Args[4] != "VIEW" || query.Args[5] != 511 || query.Args[6] != 10 {
		t.Fatalf("constraints args were not normalized: %#v", query.Args)
	}
}

func TestListSessionUserTablesQueryUsesUserDictionary(t *testing.T) {
	query := oracleListSessionUserTablesQuery(metadataListConstraints{
		Filter:      "u_r",
		Limit:       501,
		Offset:      10,
		ObjectTypes: []string{"view", "TABLE", "TABLE"},
	})
	sqlText := strings.ToUpper(query.SQL)

	if !strings.Contains(sqlText, "USER_TABLES") || !strings.Contains(sqlText, "USER_OBJECTS") {
		t.Fatalf("session-user table listing should use USER_* dictionaries, got: %s", query.SQL)
	}
	if strings.Contains(sqlText, "ALL_TABLES") || strings.Contains(sqlText, "ALL_OBJECTS") {
		t.Fatalf("session-user table listing should avoid ALL_* dictionaries, got: %s", query.SQL)
	}
	if strings.Contains(sqlText, "OWNER =") {
		t.Fatalf("session-user table listing should not add owner predicates, got: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "UPPER(OBJECT_NAME) LIKE :1 ESCAPE '\\'") {
		t.Fatalf("table listing should push filter predicate, got: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "TABLE_TYPE IN (:2,:3)") {
		t.Fatalf("table listing should push table type predicate, got: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "ROWNUM <= :4") || !strings.Contains(sqlText, "DBX_RN > :5") {
		t.Fatalf("table listing should use rownum pagination, got: %s", query.SQL)
	}
	if len(query.Args) != 5 {
		t.Fatalf("unexpected args: %#v", query.Args)
	}
	if query.Args[0] != "%U%\\_%R%" || query.Args[1] != "TABLE" || query.Args[2] != "VIEW" || query.Args[3] != 511 || query.Args[4] != 10 {
		t.Fatalf("constraints args were not normalized: %#v", query.Args)
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
	if !strings.Contains(sqlText, "'PACKAGE BODY'") || !strings.Contains(sqlText, "PACKAGE_BODY") {
		t.Fatalf("object listing should include package bodies with normalized type, got: %s", oracleListObjectsSQL)
	}
}

func TestListObjectsQueryAppliesMetadataConstraints(t *testing.T) {
	query := oracleListObjectsQuery("APP", metadataListConstraints{
		Filter:      "pkg%",
		Limit:       25,
		ObjectTypes: []string{"FUNCTION", "package"},
	})
	sqlText := strings.ToUpper(query.SQL)

	if !strings.Contains(sqlText, "UPPER(OBJECT_NAME) LIKE :3 ESCAPE '\\'") {
		t.Fatalf("object listing should push filter predicate, got: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "OBJECT_TYPE IN (:4,:5)") {
		t.Fatalf("object listing should push object type predicate, got: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "ROWNUM <= :6") || !strings.Contains(sqlText, "DBX_RN > :7") {
		t.Fatalf("object listing should use rownum pagination, got: %s", query.SQL)
	}
	if len(query.Args) != 7 {
		t.Fatalf("unexpected args: %#v", query.Args)
	}
	if query.Args[2] != "%P%K%G%\\%%" || query.Args[3] != "FUNCTION" || query.Args[4] != "PACKAGE" || query.Args[5] != 25 || query.Args[6] != 0 {
		t.Fatalf("object constraints args were not normalized: %#v", query.Args)
	}
}

func TestListSessionUserObjectsQueryUsesUserDictionary(t *testing.T) {
	query := oracleListSessionUserObjectsQuery(metadataListConstraints{
		Filter:      "pkg%",
		Limit:       25,
		ObjectTypes: []string{"FUNCTION", "package"},
	})
	sqlText := strings.ToUpper(query.SQL)

	if !strings.Contains(sqlText, "USER_TABLES") || !strings.Contains(sqlText, "USER_OBJECTS") {
		t.Fatalf("session-user object listing should use USER_* dictionaries, got: %s", query.SQL)
	}
	if strings.Contains(sqlText, "ALL_TABLES") || strings.Contains(sqlText, "ALL_OBJECTS") {
		t.Fatalf("session-user object listing should avoid ALL_* dictionaries, got: %s", query.SQL)
	}
	if strings.Contains(sqlText, "OWNER =") {
		t.Fatalf("session-user object listing should not add owner predicates, got: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "UPPER(OBJECT_NAME) LIKE :1 ESCAPE '\\'") {
		t.Fatalf("object listing should push filter predicate, got: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "OBJECT_TYPE IN (:2,:3)") {
		t.Fatalf("object listing should push object type predicate, got: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "ROWNUM <= :4") || !strings.Contains(sqlText, "DBX_RN > :5") {
		t.Fatalf("object listing should use rownum pagination, got: %s", query.SQL)
	}
	if len(query.Args) != 5 {
		t.Fatalf("unexpected args: %#v", query.Args)
	}
	if query.Args[0] != "%P%K%G%\\%%" || query.Args[1] != "FUNCTION" || query.Args[2] != "PACKAGE" || query.Args[3] != 25 || query.Args[4] != 0 {
		t.Fatalf("object constraints args were not normalized: %#v", query.Args)
	}
}

func TestOracleListTriggersSQLLoadsSourceWithoutLongColumns(t *testing.T) {
	sqlText := strings.ToUpper(oracleListTriggersSQL)

	if !strings.Contains(sqlText, "FROM ALL_TRIGGERS") || !strings.Contains(sqlText, "LEFT JOIN ALL_SOURCE") {
		t.Fatalf("trigger listing should join metadata with line-based source, got: %s", oracleListTriggersSQL)
	}
	if !strings.Contains(sqlText, "T.DESCRIPTION") || !strings.Contains(sqlText, "S.TEXT") {
		t.Fatalf("trigger listing should load the declaration and source text, got: %s", oracleListTriggersSQL)
	}
	if strings.Contains(sqlText, "TRIGGER_BODY") {
		t.Fatalf("trigger listing should avoid Oracle LONG trigger bodies, got: %s", oracleListTriggersSQL)
	}
	if !strings.Contains(sqlText, "T.OWNER = :1") || !strings.Contains(sqlText, "T.TABLE_NAME = :2") {
		t.Fatalf("trigger listing should stay scoped to the selected schema and table, got: %s", oracleListTriggersSQL)
	}
}

func TestOracleTriggerBodyStripsDictionaryDeclaration(t *testing.T) {
	source := "TRIGGER DBX_TRIGGER_4320_AUDIT\n" +
		"AFTER INSERT OR UPDATE OR DELETE ON DBX_TRIGGER_4320\n" +
		"FOR EACH ROW\n" +
		"DECLARE\n" +
		"  V_EVENT VARCHAR2(10);\n" +
		"BEGIN\n" +
		"  V_EVENT := CASE WHEN INSERTING THEN 'INSERT' WHEN UPDATING THEN 'UPDATE' ELSE 'DELETE' END;\n" +
		"END;\n"
	description := "DBX_TRIGGER_4320_AUDIT\n" +
		"AFTER INSERT OR UPDATE OR DELETE ON DBX_TRIGGER_4320\n" +
		"FOR EACH ROW\n"

	body, ok := oracleTriggerBody(source, description)
	if !ok {
		t.Fatal("expected Oracle trigger source to produce a body")
	}
	want := "DECLARE\n  V_EVENT VARCHAR2(10);\nBEGIN\n  V_EVENT := CASE WHEN INSERTING THEN 'INSERT' WHEN UPDATING THEN 'UPDATE' ELSE 'DELETE' END;\nEND;"
	if body != want {
		t.Fatalf("trigger body = %q, want %q", body, want)
	}
}

func TestOracleTriggerBodyFallsBackToVisibleSource(t *testing.T) {
	body, ok := oracleTriggerBody("TRIGGER APP.AUDIT\nBEGIN\n  NULL;\nEND;\n", "differently formatted declaration")
	if !ok {
		t.Fatal("expected differently formatted Oracle source to remain visible")
	}
	if body != "TRIGGER APP.AUDIT\nBEGIN\n  NULL;\nEND;" {
		t.Fatalf("unexpected fallback source: %q", body)
	}
}

func TestOracleFuzzyLikePatternEscapesSpecialCharacters(t *testing.T) {
	got := oracleFuzzyLikePattern(`a_%\b`)
	want := `%a%\_%\%%\\%b%`
	if got != want {
		t.Fatalf("oracleFuzzyLikePattern() = %q, want %q", got, want)
	}
}

func TestOracleCompletionTablesQuerySearchesAcrossSchemasWithPriority(t *testing.T) {
	query := oracleCompletionTablesQuery(completionAssistantRequest{
		Database:     "ORCL",
		Schema:       "APP",
		ObjectKinds:  []string{"table", "view"},
		Mask:         "dept_d",
		GlobalSearch: true,
		MatchMode:    "prefix",
	}, "APP", 201)
	sqlText := strings.ToUpper(query.SQL)

	if !strings.Contains(sqlText, "ALL_OBJECTS") || !strings.Contains(sqlText, "ALL_SYNONYMS") {
		t.Fatalf("global completion should include objects and synonyms: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "S.TABLE_OWNER AS TARGET_OWNER") || !strings.Contains(sqlText, "S.TABLE_NAME AS TARGET_NAME") || !strings.Contains(sqlText, "S.DB_LINK IS NULL") {
		t.Fatalf("table completion should return local synonym targets for bounded validation: %s", query.SQL)
	}
	if strings.Contains(sqlText, "JOIN ALL_OBJECTS TARGET") {
		t.Fatalf("Oracle 11g completion must not join full dictionary views before applying the result limit: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, TARGET_OWNER, TARGET_NAME\nFROM (\nSELECT O.OWNER") {
		t.Fatalf("Oracle 11g requires the union to be wrapped before expression-based ordering: %s", query.SQL)
	}
	if strings.Contains(sqlText, "WHERE UPPER(OBJECT_NAME) LIKE UPPER(:1) ESCAPE '\\' AND OWNER =") {
		t.Fatalf("global completion must not restrict results to one owner: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "WHEN OWNER = :3 THEN 0") || !strings.Contains(sqlText, "WHERE ROWNUM <= :5") {
		t.Fatalf("completion should prioritize the current schema and use Oracle 11g rownum limiting: %s", query.SQL)
	}
	if len(query.Args) != 5 || query.Args[0] != `dept\_d%` || query.Args[1] != `dept\_d%` || query.Args[2] != "APP" || query.Args[3] != "dept_d" || query.Args[4] != 201 {
		t.Fatalf("unexpected completion args: %#v", query.Args)
	}
}

func TestOracleCompletionSynonymTargetsQueryIsBoundedToCandidates(t *testing.T) {
	query := oracleCompletionSynonymTargetsQuery([]oracleCompletionSynonymTarget{{Owner: "DBX_TEST", Name: "DEPT_DICT"}, {Owner: "HR", Name: "EMP_VIEW"}}, []string{"'TABLE'", "'VIEW'"})
	sqlText := strings.ToUpper(query.SQL)

	if !strings.Contains(sqlText, "O.OBJECT_TYPE IN ('TABLE','VIEW')") || !strings.Contains(sqlText, "(O.OWNER = :1 AND O.OBJECT_NAME = :2)") || !strings.Contains(sqlText, "(O.OWNER = :3 AND O.OBJECT_NAME = :4)") {
		t.Fatalf("synonym target validation should query only returned targets: %s", query.SQL)
	}
	wantArgs := []any{"DBX_TEST", "DEPT_DICT", "HR", "EMP_VIEW"}
	if !reflect.DeepEqual(query.Args, wantArgs) {
		t.Fatalf("unexpected synonym target args: %#v", query.Args)
	}
}

func TestOracleCompletionTablesQueryScopesExplicitSchema(t *testing.T) {
	query := oracleCompletionTablesQuery(completionAssistantRequest{
		Schema:       "APP",
		ParentSchema: "HR",
		ObjectKinds:  []string{"table"},
		Mask:         "EMP",
	}, "APP", 50)

	if !strings.Contains(strings.ToUpper(query.SQL), "AND O.OWNER = :2") || !strings.Contains(strings.ToUpper(query.SQL), "AND S.OWNER = :4") {
		t.Fatalf("explicit schema completion should restrict owner: %s", query.SQL)
	}
	if len(query.Args) != 7 || query.Args[1] != "HR" || query.Args[3] != "HR" || query.Args[4] != "APP" {
		t.Fatalf("unexpected scoped completion args: %#v", query.Args)
	}
}

func TestOracleCompletionRoutinesQueryUsesPublicPackageMetadata(t *testing.T) {
	query := oracleCompletionRoutinesQuery(completionAssistantRequest{
		Schema:       "HR",
		ParentSchema: "HR",
		ParentName:   "PAYROLL",
		ObjectKinds:  []string{"routine"},
		Mask:         "CALC",
	}, "HR", 200)
	sqlText := strings.ToUpper(query.SQL)

	if !strings.Contains(sqlText, "ALL_PROCEDURES") || !strings.Contains(sqlText, "ALL_ARGUMENTS") {
		t.Fatalf("package completion should use callable procedure metadata: %s", query.SQL)
	}
	if strings.Contains(sqlText, "ALL_SOURCE") || strings.Contains(sqlText, "PACKAGE BODY") {
		t.Fatalf("package completion must not expose private package body source: %s", query.SQL)
	}
	if !strings.Contains(sqlText, "P.OBJECT_NAME = :1") || !strings.Contains(sqlText, "UPPER(OBJECT_NAME) LIKE UPPER(:2)") || !strings.Contains(sqlText, "AND OWNER = :3") {
		t.Fatalf("package completion should scope package and owner: %s", query.SQL)
	}
	if len(query.Args) != 6 || query.Args[0] != "PAYROLL" || query.Args[1] != "CALC%" || query.Args[2] != "HR" {
		t.Fatalf("unexpected package completion args: %#v", query.Args)
	}
}

func TestOracleCompletionLikePatternSupportsPrefixAndContains(t *testing.T) {
	if got := oracleCompletionLikePattern(`A_%`, "prefix"); got != `A\_\%%` {
		t.Fatalf("prefix pattern = %q", got)
	}
	if got := oracleCompletionLikePattern("DEPT", "contains"); got != "%DEPT%" {
		t.Fatalf("contains pattern = %q", got)
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

func TestOracleColumnTypeNamesContainXMLType(t *testing.T) {
	tests := []struct {
		name      string
		typeNames []string
		want      bool
	}{
		{name: "plain xmltype", typeNames: []string{"NUMBER", "XMLTYPE"}, want: true},
		{name: "qualified xmltype", typeNames: []string{"SYS.XMLTYPE"}, want: true},
		{name: "case and spaces", typeNames: []string{" varchar2 ", "sys.xmltype"}, want: true},
		{name: "ordinary columns", typeNames: []string{"NUMBER", "VARCHAR2", "DATE"}, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := oracleColumnTypeNamesContainXMLType(tt.typeNames); got != tt.want {
				t.Fatalf("oracleColumnTypeNamesContainXMLType(%v) = %v, want %v", tt.typeNames, got, tt.want)
			}
		})
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

// -- fake drivers for timeout tests --

func init() {
	sql.Register("oracle-test-dml", &oracleDMLDriver{})
	sql.Register("oracle-test-fast", &oracleFastDriver{})
}

// oracleDMLDriver: ExecContext blocks until ctx.Done, simulating a long-running DML.
type oracleDMLDriver struct{}

func (d *oracleDMLDriver) Open(name string) (driver.Conn, error) {
	return &oracleDMLConn{}, nil
}

type oracleDMLConn struct{}

func (c *oracleDMLConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("use ExecContext directly")
}
func (c *oracleDMLConn) Close() error              { return nil }
func (c *oracleDMLConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }

var _ driver.ExecerContext = (*oracleDMLConn)(nil)

func (c *oracleDMLConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// oracleFastDriver: returns rows quickly for cursor survival tests.
type oracleFastDriver struct{}

func (d *oracleFastDriver) Open(name string) (driver.Conn, error) {
	return &oracleFastConn{}, nil
}

type oracleFastConn struct{}

func (c *oracleFastConn) Prepare(query string) (driver.Stmt, error) {
	return &oracleFastStmt{}, nil
}
func (c *oracleFastConn) Close() error              { return nil }
func (c *oracleFastConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }

type oracleFastStmt struct{}

func (s *oracleFastStmt) Close() error  { return nil }
func (s *oracleFastStmt) NumInput() int { return -1 }
func (s *oracleFastStmt) Exec(args []driver.Value) (driver.Result, error) {
	return driver.ResultNoRows, nil
}
func (s *oracleFastStmt) Query(args []driver.Value) (driver.Rows, error) {
	return &oracleFastRows{}, nil
}

type oracleFastRows struct {
	pos    int
	closed bool
}

func (r *oracleFastRows) Columns() []string { return []string{"id"} }
func (r *oracleFastRows) Close() error      { r.closed = true; return nil }
func (r *oracleFastRows) Next(dest []driver.Value) error {
	if r.pos >= 3 || r.closed {
		return io.EOF
	}
	dest[0] = int64(r.pos + 1)
	r.pos++
	return nil
}

// -- timeout tests --

func TestOracleDMLCancelInterruptsExecContext(t *testing.T) {
	s := newServer()
	db, err := sql.Open("oracle-test-dml", "dsn")
	if err != nil {
		t.Fatal(err)
	}
	s.db = db

	errCh := make(chan error, 1)
	go func() {
		_, execErr := s.executeQuery(queryOptions{
			SQL:         "UPDATE test SET x = 1",
			TimeoutSecs: 0,
		})
		errCh <- execErr
	}()

	// Give the goroutine time to enter ExecContext and block.
	time.Sleep(200 * time.Millisecond)

	s.cancelActiveQuery()

	select {
	case execErr := <-errCh:
		if execErr == nil {
			t.Fatal("expected non-nil error after DML cancel")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("executeQuery did not return after cancelActiveQuery")
	}
}

func TestOracleCursorSurvivesDeadlineWindow(t *testing.T) {
	s := newServer()
	db, err := sql.Open("oracle-test-fast", "dsn")
	if err != nil {
		t.Fatal(err)
	}
	s.db = db

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
	for range cols {
		// placeholder
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
}
