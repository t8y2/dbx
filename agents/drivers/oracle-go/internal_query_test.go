package main

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func schemaSwitchCount(drv *oracleDBMSOutputDriver) int {
	drv.mu.Lock()
	defer drv.mu.Unlock()
	count := 0
	for _, statement := range drv.statements {
		if strings.HasPrefix(statement, "ALTER SESSION SET CURRENT_SCHEMA") {
			count++
		}
	}
	return count
}

func eventsSince(drv *oracleDBMSOutputDriver, mark int) []string {
	return append([]string(nil), drv.eventLog()[mark:]...)
}

func queryParams(t *testing.T, values map[string]any) map[string]json.RawMessage {
	t.Helper()
	params := map[string]json.RawMessage{}
	for key, value := range values {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		params[key] = raw
	}
	return params
}

func TestInternalQueryReadsWithoutDBMSOutput(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db

	// A user statement first, so the session has capture enabled.
	if _, err := s.executeQuery(queryOptions{SQL: "SELECT N FROM T"}); err != nil {
		t.Fatalf("user query failed: %v", err)
	}
	mark := len(drv.eventLog())
	result, err := s.executeQuery(queryOptions{SQL: "SELECT N FROM T", SkipServerOutput: true})
	if err != nil {
		t.Fatalf("internal query failed: %v", err)
	}
	if len(result.Rows) != 3 {
		t.Fatalf("internal query rows = %d, want 3", len(result.Rows))
	}
	if events := eventsSince(drv, mark); strings.Join(events, ",") != "query" {
		t.Fatalf("internal query events = %v, want only the query: no DISABLE/ENABLE/GET_LINES round trips", events)
	}

	// Capture for the next user statement is unaffected.
	drv.scriptLines([]string{"after-internal"})
	mark = len(drv.eventLog())
	userResult, err := s.executeQuery(queryOptions{SQL: "SELECT N FROM T"})
	if err != nil {
		t.Fatalf("user query after internal one failed: %v", err)
	}
	if !strings.Contains(strings.Join(eventsSince(drv, mark), ","), "get_line") {
		t.Fatal("user statement after an internal query no longer drains DBMS_OUTPUT")
	}
	if len(userResult.Messages) != 1 || userResult.Messages[0].Message != "after-internal" {
		t.Fatalf("user statement messages = %+v, want its own line only", userResult.Messages)
	}
}

func TestInternalQueriesReuseTheSessionSchemaUntilAnotherRequest(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db
	internal := queryParams(t, map[string]any{"sql": "SELECT N FROM T", "schema": "SCOTT", "skipServerOutput": true})

	for i := 0; i < 3; i++ {
		if _, _, err := s.dispatch("execute_query", internal); err != nil {
			t.Fatalf("internal query failed: %v", err)
		}
	}
	if got := schemaSwitchCount(drv); got != 1 {
		t.Fatalf("schema switches after three internal queries = %d, want 1", got)
	}

	// A user statement may change CURRENT_SCHEMA: it always switches and clears the cache.
	user := queryParams(t, map[string]any{"sql": "SELECT N FROM T", "schema": "SCOTT"})
	if _, _, err := s.dispatch("execute_query", user); err != nil {
		t.Fatalf("user query failed: %v", err)
	}
	if got := schemaSwitchCount(drv); got != 2 {
		t.Fatalf("schema switches after the user query = %d, want 2", got)
	}
	if _, _, err := s.dispatch("execute_query", internal); err != nil {
		t.Fatalf("internal query failed: %v", err)
	}
	if got := schemaSwitchCount(drv); got != 3 {
		t.Fatalf("internal query after a user request reused a stale schema: switches = %d, want 3", got)
	}

	// Any other request clears it as well; its own outcome does not matter here.
	_, _, _ = s.dispatch("connection_info", nil)
	if _, _, err := s.dispatch("execute_query", internal); err != nil {
		t.Fatalf("internal query failed: %v", err)
	}
	if got := schemaSwitchCount(drv); got != 4 {
		t.Fatalf("internal query after another request skipped the switch: switches = %d, want 4", got)
	}
}

func TestWritesNeverTakeTheInternalPath(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db

	// Everything that can run code, change data or take locks keeps the full path.
	// (Routine definitions only compile; see TestRoutineDefinitionsSkipOnlyDBMSOutput.)
	for _, sqlText := range []string{
		"UPDATE T SET N = 1",
		"BEGIN DBX_PKG.RUN; END;",
		"DECLARE N NUMBER; BEGIN N := 1; END;",
		"CALL DBX_PKG.RUN()",
		"CREATE TABLE T2 (N NUMBER)",
		"CREATE OR REPLACE VIEW V AS SELECT N FROM T",
		"ALTER PACKAGE P COMPILE",
		"DROP PACKAGE P",
		"SELECT N FROM T FOR UPDATE",
	} {
		before := schemaSwitchCount(drv)
		for i := 0; i < 2; i++ {
			mark := len(drv.eventLog())
			if _, err := s.executeQuery(queryOptions{SQL: sqlText, Schema: "SCOTT", SkipServerOutput: true}); err != nil {
				t.Fatalf("%q failed: %v", sqlText, err)
			}
			if !strings.Contains(strings.Join(eventsSince(drv, mark), ","), "get_line") {
				t.Fatalf("%q skipped DBMS_OUTPUT capture although it is not a plain read", sqlText)
			}
		}
		if got := schemaSwitchCount(drv) - before; got != 2 {
			t.Fatalf("%q switched schema %d times over two runs, want every run", sqlText, got)
		}
		params := queryParams(t, map[string]any{"sql": sqlText, "skipServerOutput": true})
		if keepsSessionSchemas("execute_query", params) {
			t.Fatalf("%q was treated as leaving the session schema untouched", sqlText)
		}
	}

	if !keepsSessionSchemas("execute_query", queryParams(t, map[string]any{"sql": "WITH X AS (SELECT 1 FROM DUAL) SELECT * FROM X", "skipServerOutput": true})) {
		t.Fatal("a flagged read was not recognised as internal")
	}
	if keepsSessionSchemas("execute_query", queryParams(t, map[string]any{"sql": "SELECT N FROM T"})) {
		t.Fatal("an unflagged user query was treated as internal")
	}
}

func TestRoutineDefinitionRecognition(t *testing.T) {
	for _, sqlText := range []string{
		"CREATE OR REPLACE PACKAGE BODY \"SCOTT\".\"PKG1\" AS END PKG1;",
		"create or replace editionable package body app.p as end p;",
		"CREATE NONEDITIONABLE PROCEDURE P AS BEGIN NULL; END;",
		"CREATE OR REPLACE FUNCTION F RETURN NUMBER AS BEGIN RETURN 1; END;",
		"CREATE OR REPLACE PACKAGE P AS END P;",
		"CREATE OR REPLACE TRIGGER TR BEFORE INSERT ON T FOR EACH ROW BEGIN NULL; END;",
		"CREATE OR REPLACE TYPE TY AS OBJECT (N NUMBER);",
		"CREATE OR REPLACE TYPE BODY TY AS END;",
		"/* header */\n  CREATE OR REPLACE PROCEDURE P AS BEGIN NULL; END;",
	} {
		if !isRoutineDefinitionDDL(sqlText) {
			t.Errorf("%q was not recognised as a routine definition", sqlText)
		}
	}
	for _, sqlText := range []string{
		"CREATE OR REPLACE VIEW V AS SELECT 1 FROM DUAL",
		"CREATE TABLE T2 (N NUMBER)",
		"CREATE INDEX I ON T (N)",
		"CREATE OR REPLACE SYNONYM S FOR T",
		"ALTER PACKAGE P COMPILE BODY",
		"BEGIN EXECUTE IMMEDIATE 'CREATE OR REPLACE PROCEDURE P AS BEGIN NULL; END;'; END;",
		"DROP PROCEDURE P",
		"SELECT N FROM T",
	} {
		if isRoutineDefinitionDDL(sqlText) {
			t.Errorf("%q was treated as a routine definition", sqlText)
		}
	}
}

func TestRoutineDefinitionsSkipOnlyDBMSOutput(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db
	ddl := `CREATE OR REPLACE PACKAGE BODY "SCOTT"."PKG1" AS END PKG1;`
	flagged := queryParams(t, map[string]any{"sql": ddl, "schema": "SCOTT", "skipServerOutput": true})
	read := queryParams(t, map[string]any{"sql": "SELECT N FROM T", "schema": "SCOTT", "skipServerOutput": true})

	// Warm the schema cache with an internal read first.
	if _, _, err := s.dispatch("execute_query", read); err != nil {
		t.Fatalf("internal read failed: %v", err)
	}
	for i := 0; i < 2; i++ {
		before, mark := schemaSwitchCount(drv), len(drv.eventLog())
		if _, _, err := s.dispatch("execute_query", flagged); err != nil {
			t.Fatalf("flagged routine definition failed: %v", err)
		}
		events := strings.Join(eventsSince(drv, mark), ",")
		if !strings.Contains(events, "statement") {
			t.Fatalf("the routine definition did not run: events %s", events)
		}
		if strings.Contains(events, "enable") || strings.Contains(events, "get_line") || strings.Contains(events, "disable") {
			t.Fatalf("a flagged routine definition still captured DBMS_OUTPUT: events %s", events)
		}
		// The write keeps its schema switch every time, even with a warm cache.
		if got := schemaSwitchCount(drv) - before; got != 1 {
			t.Fatalf("run %d switched schema %d times, want 1", i+1, got)
		}
	}
	if keepsSessionSchemas("execute_query", flagged) {
		t.Fatal("a routine definition was allowed to keep the session schema cache")
	}
	// It cleared the cache: the next internal read switches schema again.
	before := schemaSwitchCount(drv)
	if _, _, err := s.dispatch("execute_query", read); err != nil {
		t.Fatalf("internal read failed: %v", err)
	}
	if schemaSwitchCount(drv) != before+1 {
		t.Fatal("an internal read after a routine definition reused a cached schema")
	}

	// Without the flag the same statement still captures, as every user statement does.
	mark := len(drv.eventLog())
	if _, err := s.executeQuery(queryOptions{SQL: ddl, Schema: "SCOTT"}); err != nil {
		t.Fatalf("unflagged routine definition failed: %v", err)
	}
	if !strings.Contains(strings.Join(eventsSince(drv, mark), ","), "get_line") {
		t.Fatal("an unflagged routine definition skipped DBMS_OUTPUT capture")
	}
}

func TestRoutineDefinitionsStillReportCompilationErrors(t *testing.T) {
	db, drv := openOracleDBMSOutputTestDB(t)
	s := newServer()
	s.db = db
	drv.compileErrors = [][]driver.Value{
		{"SCOTT", "PKG1", "PACKAGE BODY", int64(12), int64(5), "PLS-00201: identifier 'X' must be declared"},
		{"SCOTT", "PKG1", "PACKAGE BODY", int64(12), int64(5), "PL/SQL: Statement ignored"},
	}
	ddl := `CREATE OR REPLACE PACKAGE BODY "SCOTT"."PKG1" AS END PKG1;`

	_, captured := s.executeQuery(queryOptions{SQL: ddl, Schema: "SCOTT", ReportCompilationErrors: true})
	_, skipped := s.executeQuery(queryOptions{SQL: ddl, Schema: "SCOTT", ReportCompilationErrors: true, SkipServerOutput: true})
	for name, err := range map[string]error{"captured path": captured, "fast path": skipped} {
		var compilation oracleCompilationError
		if !errors.As(err, &compilation) {
			t.Fatalf("%s returned %v, want the compilation error", name, err)
		}
		for _, want := range []string{"PACKAGE BODY SCOTT.PKG1 was created with compilation errors", "Line 12, column 5: PLS-00201: identifier 'X' must be declared", "PL/SQL: Statement ignored"} {
			if !strings.Contains(compilation.message, want) {
				t.Fatalf("%s compilation error %q lacks %q", name, compilation.message, want)
			}
		}
	}
	if captured.Error() != skipped.Error() {
		t.Fatalf("the fast path reported a different compilation error:\n%s\nvs\n%s", skipped, captured)
	}
}
