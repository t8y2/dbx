package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/go-zookeeper/zk"
)

func TestParseServerVersionTrimsBuiltOnSuffix(t *testing.T) {
	srvr := "Zookeeper version: 3.6.1--104dcb3dcae0bf1bca4b4a00b2d76f2b5f6d79c, built on 04/21/2020 15:01 GMT\n"
	if got := parseServerVersion(srvr); got != "3.6.1--104dcb3dcae0bf1bca4b4a00b2d76f2b5f6d79c" {
		t.Fatalf("srvr version = %q", got)
	}
	envi := "zookeeper.version=3.8.4-9a6b1d5e9c0f, built on 2024-01-01 00:00 GMT\n"
	if got := parseServerVersion(envi); got != "3.8.4-9a6b1d5e9c0f" {
		t.Fatalf("envi version = %q", got)
	}
	if got := parseServerVersion("Latency min/avg/max: 0/0/0\n"); got != "" {
		t.Fatalf("unrelated line parsed as version %q", got)
	}
}

func TestHandshakeAndRPCFailures(t *testing.T) {
	service := newServer()
	response, shutdown := service.handleRequest([]byte(`{"jsonrpc":"2.0","id":1,"method":"handshake","params":{}}`))
	if shutdown || response.Error != nil {
		t.Fatalf("handshake response = %#v, shutdown=%v", response, shutdown)
	}
	handshake, ok := response.Result.(handshakeResult)
	if !ok || handshake.ProtocolVersion != 1 || handshake.AgentProtocolVersion != 1 || strings.Join(handshake.Capabilities, ",") != "connect,test_connection,connection_info,kv" {
		t.Fatalf("unexpected handshake: %#v", response.Result)
	}

	response, _ = service.handleRequest([]byte(`{"jsonrpc":"2.0","id":"get","method":"kv_get","params":{"key":"/a"}}`))
	if response.Error == nil || response.Error.Message != "Not connected" {
		t.Fatalf("unexpected disconnected response: %#v", response)
	}
	response, _ = service.handleRequest([]byte(`{"jsonrpc":"2.0","id":2,"method":"missing","params":{}}`))
	if response.Error == nil || response.Error.Message != "Unknown method: missing" {
		t.Fatalf("unexpected unknown-method response: %#v", response)
	}
	response, _ = service.handleRequest([]byte(`not-json`))
	if response.Error == nil || response.Error.Code != -1 || response.ID != nil {
		t.Fatalf("unexpected parse response: %#v", response)
	}
}

func TestConnectionConfiguration(t *testing.T) {
	if got := connectionString(connectionConfig{ZooKeeperConnectString: " zk-main:2181 "}); got != "zk-main:2181" {
		t.Fatalf("zookeeper connect string = %q", got)
	}
	if got := connectionString(connectionConfig{ConnectString: "zk-alt:2181"}); got != "zk-alt:2181" {
		t.Fatalf("connect string = %q", got)
	}
	if got := connectionString(connectionConfig{Host: "::1", Port: 2281}); got != "[::1]:2281" {
		t.Fatalf("host fallback = %q", got)
	}
	target, err := parseConnectTarget("zookeeper://zk-a:2181, zk-b:2182/app/root/")
	if err != nil || strings.Join(target.Servers, ",") != "zk-a:2181,zk-b:2182" || target.Chroot != "/app/root" {
		t.Fatalf("target=%#v err=%v", target, err)
	}
	if got := joinPrefix("/app/", "/tenant/"); got != "/app/tenant" {
		t.Fatalf("prefix = %q", got)
	}
	for input, expected := range map[string]string{
		"host": "host:2181", "host:2281": "host:2281", "[::1]": "[::1]:2181", "[::1]:2281": "[::1]:2281", "::1": "[::1]:2181",
	} {
		got, err := endpointAddress(input)
		if err != nil || got != expected {
			t.Errorf("endpointAddress(%q)=%q,%v want %q", input, got, err, expected)
		}
	}
	if resolveAuthScheme(connectionConfig{URLParams: "?foo=1;auth_scheme=SASL_DIGEST"}) != saslDigestAuthScheme {
		t.Fatal("URL auth_scheme was not resolved")
	}
	for _, test := range []struct {
		name     string
		config   connectionConfig
		expected int
	}{
		{"default", connectionConfig{}, defaultMaxBufferSize},
		{"field", connectionConfig{MaxBufferSize: intPointer(64 * 1024 * 1024)}, 64 * 1024 * 1024},
		{"URL param", connectionConfig{URLParams: "?foo=1;max_buffer_size=16777216"}, 16 * 1024 * 1024},
		{"field precedence", connectionConfig{MaxBufferSize: intPointer(8 * 1024 * 1024), URLParams: "max_buffer_size=16777216"}, 8 * 1024 * 1024},
	} {
		t.Run("max buffer "+test.name, func(t *testing.T) {
			got, err := resolveMaxBufferSize(test.config)
			if err != nil || got != test.expected {
				t.Fatalf("resolveMaxBufferSize()=%d,%v want %d", got, err, test.expected)
			}
		})
	}
	if !hasTLSOptions(connectionConfig{CACertPath: "/tmp/ca.pem"}) {
		t.Fatal("TLS path was not detected")
	}
	for input, expected := range map[string]int{"": 16, "bad": 16, "0": 1, "32": 32, "100": 64} {
		if got := configuredStatLookupConcurrency(input); got != expected {
			t.Errorf("configuredStatLookupConcurrency(%q)=%d want %d", input, got, expected)
		}
	}
}

func TestConnectionValidationHappensBeforeNetwork(t *testing.T) {
	tests := []struct {
		name    string
		config  connectionConfig
		message string
	}{
		{"tls", connectionConfig{SSL: true}, "ZooKeeper TLS is not supported"},
		{"auth", connectionConfig{AuthScheme: "sasl"}, `Unsupported auth_scheme "sasl"`},
		{"sasl username", connectionConfig{AuthScheme: saslDigestAuthScheme, Password: "secret"}, `username is required when auth_scheme = "sasl_digest"`},
		{"sasl password", connectionConfig{AuthScheme: saslDigestAuthScheme, Username: "user"}, `password is required when auth_scheme = "sasl_digest"`},
		{"negative base sleep", connectionConfig{BaseSleepTimeMS: intPointer(-1)}, "base_sleep_time_ms must be non-negative"},
		{"negative retries", connectionConfig{MaxRetries: intPointer(-1)}, "max_retries must be non-negative"},
		{"invalid max buffer", connectionConfig{URLParams: "max_buffer_size=large"}, "max_buffer_size must be an integer number of bytes"},
		{"zero max buffer", connectionConfig{MaxBufferSize: intPointer(0)}, "max_buffer_size must be between 1 and"},
		{"oversized max buffer", connectionConfig{MaxBufferSize: intPointer(maximumMaxBufferSize + 1)}, "max_buffer_size must be between 1 and"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := openClient(test.config)
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("error=%v want substring %q", err, test.message)
			}
		})
	}
}

func intPointer(value int) *int { return &value }

func TestPathValueCursorAndCreateModes(t *testing.T) {
	for input, expected := range map[string]string{"": "/", "/": "/", "app": "/app", "/app/": "/app", "//app//": "//app"} {
		if got := normalizePath(input); got != expected {
			t.Errorf("normalizePath(%q)=%q want %q", input, got, expected)
		}
	}
	if got := encodeValue([]byte("hello")); got.Encoding != "utf8" || got.Data != "hello" {
		t.Fatalf("utf8 value = %#v", got)
	}
	binaryValue := []byte{0xff, 0x00, 0x81}
	encoded := encodeValue(binaryValue)
	if encoded.Encoding != "base64" || encoded.Data != base64.StdEncoding.EncodeToString(binaryValue) {
		t.Fatalf("binary value = %#v", encoded)
	}
	decoded, err := decodeValue(encoded)
	if err != nil || !bytes.Equal(decoded, binaryValue) {
		t.Fatalf("decoded=%v err=%v", decoded, err)
	}
	if _, err := decodeValue(valueObject{Encoding: "hex"}); err == nil {
		t.Fatal("unsupported encoding was accepted")
	}
	cursor := listCursor{Root: "/app", Recursive: true, Offset: 12}
	continuation, err := encodeCursor(cursor)
	if err != nil {
		t.Fatal(err)
	}
	decodedCursor, err := decodeCursor(continuation)
	if err != nil || decodedCursor != cursor {
		t.Fatalf("cursor=%#v err=%v", decodedCursor, err)
	}
	for mode, expected := range map[string]int32{"": 0, "persistent": 0, "ephemeral": zk.FlagEphemeral, "persistent_sequential": zk.FlagSequence, "ephemeral_sequential": zk.FlagEphemeral | zk.FlagSequence} {
		flags, err := createFlags(mode)
		if err != nil || flags != expected {
			t.Errorf("createFlags(%q)=%d,%v want %d", mode, flags, err, expected)
		}
	}
}

func TestZooKeeperRetryClassification(t *testing.T) {
	for _, err := range []error{zk.ErrConnectionClosed, zk.ErrClosing, zk.ErrSessionMoved} {
		if !isRetryableZooKeeperError(err) {
			t.Fatalf("expected retryable error: %v", err)
		}
	}
	for _, err := range []error{zk.ErrNoNode, zk.ErrAuthFailed, zk.ErrSessionExpired} {
		if isRetryableZooKeeperError(err) {
			t.Fatalf("unexpected retryable error: %v", err)
		}
	}
}

func TestKVOperationsAndPagination(t *testing.T) {
	client := newMemoryClient()
	service := &server{activeClient: client, statLookupConcurrency: 4}
	put := func(payload string) map[string]any {
		result, err := service.put(json.RawMessage(payload))
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	put(`{"key":"/app/name","value":{"encoding":"utf8","data":"dbx"}}`)
	put(`{"key":"/app/a","value":{"encoding":"base64","data":"/wA="},"writeMode":"create"}`)
	sequential := put(`{"key":"/app/seq-","value":{"data":"v"},"writeMode":"create","createMode":"persistent_sequential"}`)
	if !strings.HasPrefix(sequential["createdKey"].(string), "/app/seq-") {
		t.Fatalf("sequential result = %#v", sequential)
	}
	got, err := service.get(json.RawMessage(`{"key":"app/name/"}`))
	if err != nil || got["found"] != true || got["value"].(valueObject).Data != "dbx" {
		t.Fatalf("get=%#v err=%v", got, err)
	}
	put(`{"key":"/app/name","value":{"data":"dbx2"},"writeMode":"update"}`)

	recursive := true
	first, err := service.listPrefix(mustJSON(listRequest{Prefix: "/", Recursive: &recursive, Limit: 2}))
	if err != nil || len(first.Keys) != 2 || first.Continuation == nil {
		t.Fatalf("first page=%#v err=%v", first, err)
	}
	second, err := service.listPrefix(mustJSON(listRequest{Prefix: "/", Recursive: &recursive, Limit: 100, Continuation: *first.Continuation}))
	if err != nil || len(second.Keys) < 2 || second.Continuation != nil {
		t.Fatalf("second page=%#v err=%v", second, err)
	}
	wrongRecursive := false
	if _, err := service.listPrefix(mustJSON(listRequest{Prefix: "/", Recursive: &wrongRecursive, Continuation: *first.Continuation})); err == nil || err.Error() != "Continuation does not match request" {
		t.Fatalf("continuation mismatch error=%v", err)
	}

	deleted, err := service.delete(json.RawMessage(`{"key":"/app","recursive":true}`))
	if err != nil || deleted["deleted"].(int) < 4 {
		t.Fatalf("delete=%#v err=%v", deleted, err)
	}
	missing, err := service.delete(json.RawMessage(`{"key":"/app","recursive":true}`))
	if err != nil || missing["deleted"] != 0 {
		t.Fatalf("missing delete=%#v err=%v", missing, err)
	}
	if _, err := service.put(json.RawMessage(`{"key":"/","value":{"data":"x"}}`)); err == nil || err.Error() != "Root znode cannot be modified" {
		t.Fatalf("root put error=%v", err)
	}
	if _, err := service.delete(json.RawMessage(`{"key":"/","recursive":true}`)); err == nil || err.Error() != "Root znode cannot be deleted" {
		t.Fatalf("root delete error=%v", err)
	}
}

func mustJSON(value any) json.RawMessage {
	payload, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return payload
}

type memoryNode struct {
	data []byte
	stat zk.Stat
}

type memoryClient struct {
	mutex    sync.Mutex
	nodes    map[string]*memoryNode
	sequence int
}

func newMemoryClient() *memoryClient {
	return &memoryClient{nodes: map[string]*memoryNode{"/": {stat: zk.Stat{Ctime: 1, Mtime: 1}}}}
}

func (client *memoryClient) Close() {}

func (client *memoryClient) Exists(path string) (bool, *zk.Stat, error) {
	client.mutex.Lock()
	defer client.mutex.Unlock()
	node, ok := client.nodes[path]
	if !ok {
		return false, nil, nil
	}
	stat := node.stat
	stat.NumChildren = int32(len(client.childrenLocked(path)))
	stat.DataLength = int32(len(node.data))
	return true, &stat, nil
}

func (client *memoryClient) Get(path string) ([]byte, *zk.Stat, error) {
	exists, stat, err := client.Exists(path)
	if err != nil || !exists {
		return nil, nil, zk.ErrNoNode
	}
	client.mutex.Lock()
	data := append([]byte(nil), client.nodes[path].data...)
	client.mutex.Unlock()
	return data, stat, nil
}

func (client *memoryClient) Children(path string) ([]string, *zk.Stat, error) {
	exists, stat, err := client.Exists(path)
	if err != nil || !exists {
		return nil, nil, zk.ErrNoNode
	}
	client.mutex.Lock()
	children := client.childrenLocked(path)
	client.mutex.Unlock()
	return children, stat, nil
}

func (client *memoryClient) Create(path string, data []byte, flags int32) (string, error) {
	client.mutex.Lock()
	defer client.mutex.Unlock()
	created := path
	if flags&zk.FlagSequence != 0 {
		created = fmt.Sprintf("%s%010d", path, client.sequence)
		client.sequence++
	}
	if _, exists := client.nodes[created]; exists {
		return "", zk.ErrNodeExists
	}
	if _, exists := client.nodes[parentPath(created)]; !exists {
		return "", zk.ErrNoNode
	}
	owner := int64(0)
	if flags&zk.FlagEphemeral != 0 {
		owner = 1
	}
	client.nodes[created] = &memoryNode{data: append([]byte(nil), data...), stat: zk.Stat{Ctime: 1, Mtime: 1, EphemeralOwner: owner}}
	return created, nil
}

func (client *memoryClient) Set(path string, data []byte) (*zk.Stat, error) {
	client.mutex.Lock()
	defer client.mutex.Unlock()
	node, exists := client.nodes[path]
	if !exists {
		return nil, zk.ErrNoNode
	}
	node.data = append([]byte(nil), data...)
	node.stat.Version++
	node.stat.Mtime++
	stat := node.stat
	stat.DataLength = int32(len(node.data))
	return &stat, nil
}

func (client *memoryClient) Delete(path string) error {
	client.mutex.Lock()
	defer client.mutex.Unlock()
	if _, exists := client.nodes[path]; !exists {
		return zk.ErrNoNode
	}
	if len(client.childrenLocked(path)) != 0 {
		return zk.ErrNotEmpty
	}
	delete(client.nodes, path)
	return nil
}

func (client *memoryClient) childrenLocked(path string) []string {
	prefix := path
	if prefix != "/" {
		prefix += "/"
	}
	children := make([]string, 0)
	for candidate := range client.nodes {
		if candidate == path || !strings.HasPrefix(candidate, prefix) {
			continue
		}
		remainder := strings.TrimPrefix(candidate, prefix)
		if remainder != "" && !strings.Contains(remainder, "/") {
			children = append(children, remainder)
		}
	}
	sort.Strings(children)
	return children
}

var _ znodeClient = (*memoryClient)(nil)
