package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"strings"
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

func TestEffectiveNeo4jSchemeMatchesBuiltURI(t *testing.T) {
	for _, params := range []connectParams{
		{Host: "127.0.0.1", Port: 7687},
		{Host: "db.example.com", Port: 7687, SSL: true},
		{Host: "db.example.com", Port: 7687, URLParams: "encrypted=true"},
		{Host: "db", Port: 7687, URLParams: "scheme=bolt"},
		{Host: "db", Port: 7687, URLParams: "scheme=neo4j+ssc"},
		{ConnectionString: "jdbc:neo4j://user:secret@db:7687?database=movies"},
		{ConnectionString: "bolt://db:7687"},
	} {
		uri, err := buildNeo4jURI(params)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := url.Parse(uri)
		if err != nil {
			t.Fatal(err)
		}
		if got := effectiveNeo4jScheme(params); got != parsed.Scheme {
			t.Fatalf("effectiveNeo4jScheme(%#v) = %q, want %q", params, got, parsed.Scheme)
		}
	}
}

func TestDirectConnectionParamsRewritesRoutingSchemes(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		params      connectParams
		want        connectParams
		wantChanged bool
	}{
		{
			name:        "default routing scheme becomes direct",
			params:      connectParams{Host: "db", Port: 7687},
			want:        connectParams{Host: "db", Port: 7687, URLParams: "scheme=bolt"},
			wantChanged: true,
		},
		{
			name:        "tls keeps encryption",
			params:      connectParams{Host: "db", Port: 7687, SSL: true, URLParams: "connection_timeout=5s"},
			want:        connectParams{Host: "db", Port: 7687, SSL: true, URLParams: "connection_timeout=5s&scheme=bolt+s"},
			wantChanged: true,
		},
		{
			name:        "explicit routing scheme is rewritten in place",
			params:      connectParams{Host: "db", Port: 7687, URLParams: "scheme=neo4j&database=movies"},
			want:        connectParams{Host: "db", Port: 7687, URLParams: "database=movies&scheme=bolt"},
			wantChanged: true,
		},
		{
			name:        "direct connection is kept",
			params:      connectParams{Host: "db", Port: 7687, URLParams: "scheme=bolt"},
			want:        connectParams{Host: "db", Port: 7687, URLParams: "scheme=bolt"},
			wantChanged: false,
		},
		{
			name:        "routing connection string becomes direct",
			params:      connectParams{ConnectionString: "jdbc:neo4j://user:secret@db:7687?database=movies"},
			want:        connectParams{ConnectionString: "bolt://db:7687"},
			wantChanged: true,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got, changed := directConnectionParams(testCase.params)
			if changed != testCase.wantChanged {
				t.Fatalf("directConnectionParams() changed = %t, want %t", changed, testCase.wantChanged)
			}
			if !changed {
				return
			}
			uri, err := buildNeo4jURI(got)
			if err != nil {
				t.Fatal(err)
			}
			wantURI, err := buildNeo4jURI(testCase.want)
			if err != nil {
				t.Fatal(err)
			}
			if uri != wantURI {
				t.Fatalf("directConnectionParams() built %q, want %q", uri, wantURI)
			}
		})
	}
}

func TestIsRoutingUnsupported(t *testing.T) {
	for _, testCase := range []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "driver usage error wording",
			err:  errors.New("feature not supported: Server 127.0.0.1:17690 does not support: routing (requires cluster setup)"),
			want: true,
		},
		{name: "typed feature error", err: &neo4jdb.FeatureNotSupportedError{Server: "db:7687", Feature: "routing", Reason: "requires cluster setup"}, want: true},
		{name: "typed route-to-database error", err: &neo4jdb.FeatureNotSupportedError{Server: "db:7687", Feature: "route to database", Reason: "requires at least server v4"}, want: false},
		{name: "unrelated error", err: errors.New("connection refused"), want: false},
		{name: "nil error", err: nil, want: false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if got := isRoutingUnsupported(testCase.err); got != testCase.want {
				t.Fatalf("isRoutingUnsupported(%v) = %t, want %t", testCase.err, got, testCase.want)
			}
		})
	}
}

func TestWithURLParamKeepsOtherEntries(t *testing.T) {
	cases := []struct {
		urlParams string
		want      string
	}{
		{urlParams: "", want: "scheme=bolt+s"},
		{urlParams: "scheme=neo4j", want: "scheme=bolt+s"},
		{urlParams: "max_connection_pool_size=10;scheme=neo4j", want: "max_connection_pool_size=10&scheme=bolt+s"},
		{urlParams: "a=1&b=2", want: "a=1&b=2&scheme=bolt+s"},
	}
	for _, testCase := range cases {
		if got := withURLParam(testCase.urlParams, "scheme", "bolt+s"); got != testCase.want {
			t.Fatalf("withURLParam(%q) = %q, want %q", testCase.urlParams, got, testCase.want)
		}
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
	if syntax.Data.Category != "sql" || syntax.Data.SQLState != "" || syntax.Data.AgentSessionID != "session-1" {
		t.Fatalf("unexpected syntax classification: %#v", syntax)
	}
	if syntax.Data.ContractVersion != 1 || syntax.Data.Stage != "execute" || syntax.Data.OperationOutcome != "unknown" {
		t.Fatalf("invalid structured error contract: %#v", syntax.Data)
	}
	if syntax.Message == "" || !strings.Contains(syntax.Message, "Neo.ClientError.Statement.SyntaxError") {
		t.Fatalf("Neo4j error code was lost: %q", syntax.Message)
	}
	resource := classifyRPCError("execute_query", "session-1", &neo4jdb.Neo4jError{
		Code: "Neo.TransientError.General.DatabaseUnavailable", Msg: "database unavailable",
	})
	if resource.Data.Category != "resource" || resource.Data.SessionDisposition != "replace_runtime" {
		t.Fatalf("invalid resource error contract: %#v", resource.Data)
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

func TestPropertyColumnsUseCypherTypesAndMergeLabelCombinations(t *testing.T) {
	record := func(name string, types []any, mandatory bool) *neo4j.Record {
		return &neo4j.Record{Keys: []string{"propertyName", "propertyTypes", "mandatory"}, Values: []any{name, types, mandatory}}
	}
	got := propertyColumns([]*neo4j.Record{
		record("score", []any{"Long"}, true),
		record("ratio", []any{"Double"}, true),
		record("score", []any{"String", "Long"}, false),
		record("values", []any{"LongArray", "DoubleArray"}, false),
	})
	want := []columnInfo{
		{Name: "ratio", DataType: "Float", IsNullable: false},
		{Name: "score", DataType: "Integer | String", IsNullable: true},
		{Name: "values", DataType: "FloatArray | IntegerArray", IsNullable: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("propertyColumns() = %#v, want %#v", got, want)
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
