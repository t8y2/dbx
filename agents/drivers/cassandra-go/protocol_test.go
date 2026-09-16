package main

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestHandshakeAdvertisesMultiSessionAndStructuredErrors(t *testing.T) {
	result, shutdown, err := newRuntimeServer().dispatch("handshake", nil)
	if err != nil || shutdown {
		t.Fatalf("unexpected handshake result: shutdown=%t err=%v", shutdown, err)
	}
	capabilities := result.(map[string]any)["capabilities"].([]string)
	want := []string{"connect", "test_connection", "metadata", "query", "paged_query", "transaction", "ddl", "structured_error_v1", "multi_session"}
	if !reflect.DeepEqual(capabilities, want) {
		t.Fatalf("unexpected capabilities: %#v", capabilities)
	}
}

func TestHandleLineRejectsMissingSession(t *testing.T) {
	params, _ := json.Marshal(map[string]any{"agentSessionId": "missing"})
	line := `{"jsonrpc":"2.0","id":7,"method":"validate_session","params":` + string(params) + `}`
	response, _ := newRuntimeServer().handleLine(line)
	if response.Error == nil || response.Error.Data == nil || response.Error.Data.Stage != "validate" {
		t.Fatalf("unexpected error response: %#v", response)
	}
}

func TestClassifyCanceledQuery(t *testing.T) {
	err := classifyRPCError("execute_query", "session-1", context.Canceled)
	if err.Data.Category != "canceled" || err.Data.SessionDisposition != "quarantine" {
		t.Fatalf("unexpected cancellation classification: %#v", err)
	}
}

func TestRuntimeIdentityIncludesCredentials(t *testing.T) {
	first := connectionRuntimeKey(connectParams{Host: "localhost", Username: "user", Password: "one"})
	second := connectionRuntimeKey(connectParams{Host: "localhost", Username: "user", Password: "two"})
	if first == second {
		t.Fatal("runtime identities must not share sessions across credentials")
	}
}

func TestTrimStatementSQL(t *testing.T) {
	if got := trimStatementSQL(" SELECT * FROM t;;; \n"); got != "SELECT * FROM t" {
		t.Fatalf("unexpected trimmed SQL: %q", got)
	}
}

func TestIsSchemaChangingCQL(t *testing.T) {
	for _, sql := range []string{
		"CREATE TABLE app.events (id int PRIMARY KEY)",
		" alter keyspace app with replication = {'class': 'SimpleStrategy'} ",
		"DROP INDEX app.events_idx;",
	} {
		if !isSchemaChangingCQL(sql) {
			t.Fatalf("expected schema-changing CQL: %q", sql)
		}
	}
	for _, sql := range []string{"SELECT * FROM app.events", "INSERT INTO app.events (id) VALUES (1)", "TRUNCATE app.events"} {
		if isSchemaChangingCQL(sql) {
			t.Fatalf("unexpected schema-changing CQL: %q", sql)
		}
	}
}
