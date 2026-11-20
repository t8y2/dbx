package main

import (
	"encoding/json"
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

	for _, sqlText := range []string{
		"UPDATE T SET N = 1",
		"BEGIN DBX_PKG.RUN; END;",
		"CREATE OR REPLACE PACKAGE BODY P AS END P;",
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
