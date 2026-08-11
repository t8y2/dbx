package main

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/apache/iotdb-client-go/v2/client"
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

func TestParseConnectionConfig(t *testing.T) {
	config, err := parseConnectionConfig(connectParams{
		ConnectionString: "jdbc:iotdb://alice:secret@[::1]:7777/dbx_table?sql_dialect=table&fetch_size=2048&connect_retry_max=4",
		URLParams:        "enable_compression=true&node_urls=node1:6667,node2:6667&time_zone=UTC",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.Host != "::1" || config.Port != 7777 || config.Username != "alice" || config.Password != "secret" {
		t.Fatalf("unexpected endpoint config: %#v", config)
	}
	if config.Database != "dbx_table" || config.Dialect != client.TableSqlDialect || config.FetchSize != 2048 {
		t.Fatalf("unexpected session config: %#v", config)
	}
	if !config.EnableCompression || config.ConnectRetryMax != 4 || config.TimeZone != "UTC" {
		t.Fatalf("unexpected optional config: %#v", config)
	}
	if !reflect.DeepEqual(config.NodeURLs, []string{"node1:6667", "node2:6667"}) {
		t.Fatalf("unexpected cluster nodes: %#v", config.NodeURLs)
	}
}

func TestBundledTimeZoneDatabase(t *testing.T) {
	dataSet, err := client.NewIoTDBRpcDataSet(
		"", nil, nil, nil, true, false, 0, 0, nil, 0, nil, 0, nil,
		"Asia/Shanghai", "default", 1000, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if dataSet == nil {
		t.Fatal("expected IoTDB dataset with bundled timezone data")
	}
	if _, err := client.NewIoTDBRpcDataSet(
		"", nil, nil, nil, true, false, 0, 0, nil, 0, nil, 0, nil,
		"Invalid/Zone", "default", 1000, nil,
	); err == nil {
		t.Fatal("expected invalid timezone to remain rejected")
	}
}

func TestParseConnectionConfigTLS(t *testing.T) {
	config, err := parseConnectionConfig(connectParams{
		Host: "iotdb.example.com", SSL: true, CACertPath: "/tmp/ca.pem",
		ClientCertPath: "/tmp/client.pem", ClientKeyPath: "/tmp/client.key",
		URLParams: "insecure_skip_verify=true",
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.TLSConfig == nil || config.TLSConfig.CAFile != "/tmp/ca.pem" || !config.TLSInsecureSkipVerify {
		t.Fatalf("unexpected TLS config: %#v", config.TLSConfig)
	}
	if _, err := parseConnectionConfig(connectParams{SSL: true, ClientCertPath: "/tmp/client.pem"}); err == nil {
		t.Fatal("expected incomplete mTLS configuration to fail")
	}
	if _, err := parseConnectionConfig(connectParams{URLParams: "sql_dialect=relational"}); err == nil {
		t.Fatal("expected unsupported SQL dialect to fail")
	}
}

func TestMetadataHelpers(t *testing.T) {
	values := []string{"alpha", "beta", "gamma"}
	if got := applyMetadataWindow(values, 1, 1); !reflect.DeepEqual(got, []string{"beta"}) {
		t.Fatalf("unexpected metadata window: %#v", got)
	}
	if !metadataNameMatches("DeviceOne", "vice") || metadataNameMatches("DeviceOne", "table") {
		t.Fatal("unexpected metadata name matching")
	}
	if got := treeDevicePath("root.db", "root.db.d1"); got != "root.db.d1" {
		t.Fatalf("treeDevicePath() = %q", got)
	}
	if got := quoteTreePath("root.db.with-dash"); got != "root.db.`with-dash`" {
		t.Fatalf("quoteTreePath() = %q", got)
	}
	if got := quoteTableIdentifier(`a"b`); got != `"a""b"` {
		t.Fatalf("quoteTableIdentifier() = %q", got)
	}
}

func TestNormalizeIoTDBValues(t *testing.T) {
	when := time.Date(2026, time.August, 10, 12, 34, 56, 123, time.FixedZone("CST", 8*60*60))
	if got := normalizeIoTDBValue(when, "TIMESTAMP"); got != "2026-08-10T12:34:56.000000123+08:00" {
		t.Fatalf("unexpected timestamp: %#v", got)
	}
	if got := normalizeIoTDBValue(when, "DATE"); got != "2026-08-10" {
		t.Fatalf("unexpected date: %#v", got)
	}
	if got := normalizeIoTDBValue([]byte{0xde, 0xad}, "BLOB"); got != "dead" {
		t.Fatalf("unexpected blob: %#v", got)
	}
}

func TestClassifyIoTDBErrors(t *testing.T) {
	canceled := classifyRPCError("execute_query", "session-1", context.Canceled)
	if canceled.Data.Category != "canceled" || canceled.Data.SessionDisposition != "quarantine" {
		t.Fatalf("unexpected cancellation classification: %#v", canceled)
	}
	timedOut := classifyRPCError("execute_query", "session-1", context.DeadlineExceeded)
	if timedOut.Data.Category != "timeout" || timedOut.Data.SessionDisposition != "quarantine" {
		t.Fatalf("unexpected timeout classification: %#v", timedOut)
	}
}

func TestDecodeQueryOptions(t *testing.T) {
	params := map[string]json.RawMessage{
		"sql":         json.RawMessage(`"SHOW DATABASES"`),
		"maxRows":     json.RawMessage(`100`),
		"fetchSize":   json.RawMessage(`25`),
		"timeoutSecs": json.RawMessage(`5`),
	}
	options := queryOptionsFromParams(params)
	if options.SQL != "SHOW DATABASES" || options.MaxRows != 100 || options.FetchSize != 25 || options.TimeoutSecs != 5 {
		t.Fatalf("unexpected query options: %#v", options)
	}
}

func TestCancelActiveOperationInvalidatesClient(t *testing.T) {
	blocking := &blockingIoTDBSession{closed: make(chan struct{})}
	connected := &sessionClient{session: blocking, dialect: client.TreeSqlDialect}
	server := &server{client: connected}
	done := make(chan error, 1)
	go func() {
		_, err := runCancelable(server, 0, connected, func(ctx context.Context) (struct{}, error) {
			<-ctx.Done()
			return struct{}{}, ctx.Err()
		})
		done <- err
	}()
	deadline := time.Now().Add(time.Second)
	for {
		server.activeMu.Lock()
		active := server.activeCancel != nil
		server.activeMu.Unlock()
		if active {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("operation never became active")
		}
		time.Sleep(time.Millisecond)
	}
	server.cancelActiveQuery()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("runCancelable() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled operation did not return")
	}
	server.clientMu.Lock()
	defer server.clientMu.Unlock()
	if server.client != nil {
		t.Fatal("canceled client must be invalidated")
	}
}

type blockingIoTDBSession struct {
	closed chan struct{}
}

func (s *blockingIoTDBSession) ExecuteQueryStatement(context.Context, string, *int64) (*client.SessionDataSet, error) {
	return nil, errors.New("not implemented")
}

func (s *blockingIoTDBSession) ExecuteNonQueryStatement(context.Context, string) error {
	return errors.New("not implemented")
}

func (s *blockingIoTDBSession) Close() error {
	select {
	case <-s.closed:
	default:
		close(s.closed)
	}
	return nil
}
