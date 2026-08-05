package main

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	neo4j "github.com/neo4j/neo4j-go-driver/v6/neo4j"
	neo4jdb "github.com/neo4j/neo4j-go-driver/v6/neo4j/db"
)

func TestHandshakeAdvertisesNativeCapabilities(t *testing.T) {
	result, shutdown, err := newRuntimeServer().dispatch("handshake", nil)
	if err != nil || shutdown {
		t.Fatalf("unexpected handshake: shutdown=%t err=%v", shutdown, err)
	}
	capabilities := result.(map[string]any)["capabilities"].([]string)
	want := []string{
		"connect", "test_connection", "metadata", "query", "paged_query", "transaction", "ddl",
		"structured_error_v1", "multi_session",
	}
	if !reflect.DeepEqual(capabilities, want) {
		t.Fatalf("unexpected capabilities: %#v", capabilities)
	}
}

func TestHandleLineClassifiesMissingSession(t *testing.T) {
	response, _ := newRuntimeServer().handleLine(
		`{"jsonrpc":"2.0","id":7,"method":"validate_session","params":{"agentSessionId":"missing"}}`,
	)
	if response.Error == nil || response.Error.Data == nil {
		t.Fatalf("expected structured error: %#v", response)
	}
	if response.Error.Data.Stage != "validate" || response.Error.Data.Category != "protocol" {
		t.Fatalf("unexpected error classification: %#v", response.Error.Data)
	}
}

func TestConnectionRuntimeIdentityIncludesCredentials(t *testing.T) {
	first := connectionRuntimeKey(connectParams{Host: "localhost", Username: "neo4j", Password: "one"})
	second := connectionRuntimeKey(connectParams{Host: "localhost", Username: "neo4j", Password: "two"})
	if first == second {
		t.Fatal("runtime identities must not share drivers across credentials")
	}
}

func TestBuildNeo4jURI(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		params connectParams
		want   string
	}{
		{name: "default", params: connectParams{Host: "127.0.0.1", Port: 7687}, want: "neo4j://127.0.0.1:7687"},
		{name: "ssl", params: connectParams{Host: "db.example.com", Port: 7687, SSL: true}, want: "neo4j+s://db.example.com:7687"},
		{name: "ssl url param", params: connectParams{Host: "db.example.com", Port: 7687, URLParams: "encrypted=true"}, want: "neo4j+s://db.example.com:7687"},
		{name: "direct", params: connectParams{Host: "db", Port: 7687, URLParams: "scheme=bolt"}, want: "bolt://db:7687"},
		{name: "jdbc migration", params: connectParams{ConnectionString: "jdbc:neo4j://user:secret@db:7687?database=movies"}, want: "neo4j://db:7687"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := buildNeo4jURI(testCase.params)
			if err != nil {
				t.Fatal(err)
			}
			if got != testCase.want {
				t.Fatalf("buildNeo4jURI() = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestConfiguredDatabaseUsesConnectionString(t *testing.T) {
	if got := configuredDatabase(connectParams{ConnectionString: "jdbc:neo4j://db:7687?database=movies"}); got != "movies" {
		t.Fatalf("configuredDatabase() = %q, want movies", got)
	}
	if got := configuredDatabase(connectParams{ConnectionString: "neo4j://db:7687/archive"}); got != "archive" {
		t.Fatalf("configuredDatabase() = %q, want archive", got)
	}
}

func TestMetadataWindowAndFiltering(t *testing.T) {
	values := []string{"alpha", "beta", "gamma"}
	if got := applyMetadataWindow(values, 1, 1); !reflect.DeepEqual(got, []string{"beta"}) {
		t.Fatalf("unexpected metadata window: %#v", got)
	}
	if !metadataNameMatches("Employee", "ploy") || metadataNameMatches("Employee", "customer") {
		t.Fatal("unexpected metadata name matching")
	}
}

func TestNormalizeQueryValuesPreservesLegacyStringRows(t *testing.T) {
	node := neo4j.Node{ElementId: "4:abc:7", Labels: []string{"Person"}, Props: map[string]any{"name": "Ada", "age": int64(37)}}
	if got := normalizeQueryValue(int64(42)); got != "42" {
		t.Fatalf("unexpected integer normalization: %#v", got)
	}
	if got := normalizeQueryValue(node); got != `(:Person {"age":37,"name":"Ada"})` {
		t.Fatalf("unexpected node normalization: %#v", got)
	}
}

func TestClassifyNeo4jErrors(t *testing.T) {
	syntax := classifyRPCError("execute_query", "session-1", &neo4jdb.Neo4jError{
		Code: "Neo.ClientError.Statement.SyntaxError", Msg: "invalid input",
	})
	if syntax.Data.Category != "sql" || syntax.Data.SQLState == "" {
		t.Fatalf("unexpected syntax classification: %#v", syntax)
	}
	canceled := classifyRPCError("execute_query", "session-1", context.Canceled)
	if canceled.Data.Category != "canceled" || canceled.Data.SessionDisposition != "quarantine" {
		t.Fatalf("unexpected cancellation classification: %#v", canceled)
	}
}

func TestDecodeQueryOptions(t *testing.T) {
	params := map[string]json.RawMessage{
		"sql":         json.RawMessage(`"RETURN 1"`),
		"maxRows":     json.RawMessage(`100`),
		"timeoutSecs": json.RawMessage(`5`),
	}
	var options queryOptions
	if err := decodeParams(params, &options); err != nil {
		t.Fatal(err)
	}
	if options.SQL != "RETURN 1" || options.MaxRows != 100 || options.TimeoutSecs != 5 {
		t.Fatalf("unexpected query options: %#v", options)
	}
}

func TestBoundedQueryUsesFetchAll(t *testing.T) {
	options := queryOptions{SQL: "MATCH (n) RETURN n LIMIT 10000", MaxRows: 10000}
	if got := effectiveFetchSize(options); got != neo4j.FetchAll {
		t.Fatalf("effectiveFetchSize() = %d, want FetchAll", got)
	}
	options.SQL = "MATCH (n) RETURN n"
	if got := effectiveFetchSize(options); got == neo4j.FetchAll {
		t.Fatal("unbounded query must not use FetchAll")
	}
	options = queryOptions{SQL: "MATCH (n) RETURN n LIMIT 100000", MaxRows: 100000}
	if got := effectiveFetchSize(options); got == neo4j.FetchAll {
		t.Fatal("large bounded query must keep batched fetching")
	}
}
