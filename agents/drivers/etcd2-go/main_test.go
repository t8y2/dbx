package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHandshakeAdvertisesV2Capabilities(t *testing.T) {
	server := newRuntimeServer()
	result, _, err := server.dispatch("handshake", nil)
	if err != nil {
		t.Fatalf("handshake failed: %v", err)
	}
	handshake := result.(map[string]any)
	want := []string{
		"connect", "test_connection", "kv", "kv_ttl", "kv_cas", "kv_list_values",
		"kv_status", "etcd_watch", "etcd_auth", "multi_session",
	}
	got := handshake["capabilities"].([]string)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("capability mismatch:\n got %v\nwant %v", got, want)
	}
	for _, forbidden := range []string{"kv_history", "etcd_lease", "etcd_compaction", "etcd_defrag", "structured_error_v1"} {
		for _, capability := range got {
			if capability == forbidden {
				t.Fatalf("%s must not be advertised on the v2 agent", forbidden)
			}
		}
	}
}

func TestHandleLineReportsSessionNotFound(t *testing.T) {
	server := newRuntimeServer()
	response, _ := server.handleLine(`{"id":7,"method":"kv_get","params":{"key":"a"}}`)
	if response.Error == nil || response.Error.Code != -1 {
		t.Fatalf("expected code -1 error, got %#v", response)
	}
	if response.Error.Message != "Agent session not found: __legacy__" {
		t.Fatalf("unexpected message: %q", response.Error.Message)
	}
}

func TestUnconnectedSessionErrors(t *testing.T) {
	state := newEtcd2Session()
	if _, err := state.get(map[string]json.RawMessage{"key": json.RawMessage(`"k"`)}); err == nil || err.Error() != "Not connected" {
		t.Fatalf("kv_get before connect: %v", err)
	}
	if _, err := state.validateConnection(); err == nil || err.Error() != "Not connected" {
		t.Fatalf("validate_connection before connect: %v", err)
	}
}

func TestEtcd3OnlyMethodsRejected(t *testing.T) {
	state := newEtcd2Session()
	for _, method := range []string{"kv_history", "etcd_lease_list", "etcd_lease_grant", "etcd_compact", "etcd_defrag"} {
		_, err := state.handle(method, map[string]json.RawMessage{})
		if err == nil || !strings.HasPrefix(err.Error(), "ETCD_V2_UNSUPPORTED") {
			t.Fatalf("%s should report ETCD_V2_UNSUPPORTED, got %v", method, err)
		}
	}
	_, err := state.handle("etcd_nonsense", map[string]json.RawMessage{})
	if err == nil || !strings.Contains(err.Error(), "unknown method") {
		t.Fatalf("expected unknown method error, got %v", err)
	}
}

func TestConnectionEndpoints(t *testing.T) {
	cases := []struct {
		name       string
		connection connectionParams
		want       []string
	}{
		{"host port fallback", connectionParams{Port: 2379}, []string{"http://127.0.0.1:2379"}},
		{"ssl scheme", connectionParams{Host: "db", Port: 1, SSL: true}, []string{"https://db:1"}},
		{"comma list", connectionParams{EtcdEndpoints: "a:1,b:2"}, []string{"http://a:1", "http://b:2"}},
		{"existing scheme trimmed", connectionParams{EtcdEndpoints: "https://a:1/"}, []string{"https://a:1"}},
	}
	for _, testCase := range cases {
		got := connectionEndpoints(testCase.connection)
		if strings.Join(got, "|") != strings.Join(testCase.want, "|") {
			t.Fatalf("%s: got %v, want %v", testCase.name, got, testCase.want)
		}
	}
}

func TestTLSConfigRequiresCertAndKeyTogether(t *testing.T) {
	_, err := tlsConfigFor(connectionParams{SSL: true, ClientCertPath: "/tmp/cert.pem"})
	if err == nil || err.Error() != "Client certificate and key must be provided together" {
		t.Fatalf("expected paired cert/key error, got %v", err)
	}
}

func TestV2KeyPath(t *testing.T) {
	cases := []struct{ key, want string }{
		{"", "/v2/keys/"},
		{"foo", "/v2/keys/foo"},
		{"/foo/bar", "/v2/keys/foo/bar"},
	}
	for _, testCase := range cases {
		if got := v2KeyPath(testCase.key); got != testCase.want {
			t.Fatalf("v2KeyPath(%q) = %q, want %q", testCase.key, got, testCase.want)
		}
	}
}

func TestErrorFromResponse(t *testing.T) {
	err := errorFromResponse(404, []byte(`{"errorCode":100,"message":"Key not found","cause":"/foo","index":37}`))
	if !isNotFound(err) {
		t.Fatalf("expected key-not-found classification: %#v", err)
	}
	if isCompareFailed(err) {
		t.Fatalf("errorCode 100 is not compare failure")
	}
	if err.Error() != "Key not found (/foo)" {
		t.Fatalf("unexpected message: %q", err.Error())
	}
	compare := errorFromResponse(412, []byte(`{"errorCode":101,"message":"Compare failed","cause":"[1 != 2]"}`))
	if !isCompareFailed(compare) {
		t.Fatalf("expected compare failure classification: %#v", compare)
	}
	plain := errorFromResponse(500, []byte("boom"))
	if plain.Error() != "boom" {
		t.Fatalf("plain body passthrough broken: %q", plain.Error())
	}
}

func TestV2PermissionRows(t *testing.T) {
	rows := v2PermissionRows("read", []string{"/a", "/p/*"})
	if len(rows) != 2 {
		t.Fatalf("expected 2 permission rows, got %d", len(rows))
	}
	first := rows[0]
	if first["access"] != "read" || first["resource"] != "key" {
		t.Fatalf("unexpected exact-key row: %#v", first)
	}
	second := rows[1]
	if second["access"] != "read" || second["resource"] != "prefix" {
		t.Fatalf("unexpected prefix row: %#v", second)
	}
	end := second["rangeEnd"].(map[string]any)
	if end["data"] != "L3Aw" { // prefixEnd("/p/") == "/p0"
		t.Fatalf("prefix rangeEnd wrong: %#v", end)
	}
}

func TestV2PermissionPattern(t *testing.T) {
	if got := v2PermissionPattern("key", "/foo"); got != "/foo" {
		t.Fatalf("key pattern must stay bare: %q", got)
	}
	if got := v2PermissionPattern("prefix", "/foo/"); got != "/foo/*" {
		t.Fatalf("prefix pattern must become glob: %q", got)
	}
	if got := v2PermissionPattern("all", "/ignored"); got != "/*" {
		t.Fatalf("all pattern must be root glob: %q", got)
	}
}

func TestV2RoleGrantDocument(t *testing.T) {
	encoded, err := json.Marshal(v2Role{
		Role:  "r1",
		Grant: &v2Permissions{KV: v2RWPermission{Read: []string{"/p/*"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var round v2Role
	if err := json.Unmarshal(encoded, &round); err != nil {
		t.Fatal(err)
	}
	if round.Role != "r1" || len(round.Grant.KV.Read) != 1 || round.Grant.KV.Read[0] != "/p/*" {
		t.Fatalf("grant document round-trip broken: %s", encoded)
	}
	if round.Permissions != nil {
		t.Fatalf("grant documents must not carry permissions: %s", encoded)
	}
}

func TestMemberHexToUnsigned(t *testing.T) {
	if got := memberHexToUnsigned("272e204152"); got != "168277590354" {
		t.Fatalf("unexpected conversion: %v", got)
	}
	if got := memberHexToUnsigned(""); got != nil {
		t.Fatalf("empty id must map to nil, got %v", got)
	}
	if got := memberHexToUnsigned("zzz"); got != nil {
		t.Fatalf("invalid hex must map to nil, got %v", got)
	}
}

func TestWatchBudgetState(t *testing.T) {
	session := newEtcd2Session()
	state := &watchState{watchID: "w", session: session}
	state.append(10, []map[string]any{{"eventType": "put"}}, 128)
	state.append(11, []map[string]any{{"eventType": "put"}}, maxWatchBufferBytes+1)
	polled := state.poll()
	if len(polled["batches"].([]any)) != 1 {
		t.Fatalf("overflow must keep buffered batch: %#v", polled)
	}
	terminal, ok := polled["terminal"].(map[string]any)
	if !ok || terminal["reason"] != "overflow" {
		t.Fatalf("expected overflow terminal: %#v", polled)
	}
	if session.watchBufferedBytesSnapshot() != 0 {
		t.Fatalf("budget not released: %d", session.watchBufferedBytesSnapshot())
	}
}

func TestWatchLimits(t *testing.T) {
	session := newEtcd2Session()
	for i := 0; i < maxWatches; i++ {
		session.registerWatch(string(rune('a'+i)), &watchState{watchID: string(rune('a' + i)), session: session})
	}
	_, err := session.watchStart(map[string]json.RawMessage{"key": json.RawMessage(`"k"`)})
	if err == nil || !strings.HasPrefix(err.Error(), "ETCD_WATCH_LIMIT") {
		t.Fatalf("expected watch limit error, got %v", err)
	}
	fresh := newEtcd2Session()
	_, err = fresh.watchStart(map[string]json.RawMessage{"key": json.RawMessage(`"k"`), "scope": json.RawMessage(`"glob"`)})
	if err == nil || err.Error() != "ETCD_WATCH_SCOPE_INVALID: scope must be key or prefix" {
		t.Fatalf("expected scope error, got %v", err)
	}
	_, err = fresh.watchPoll(map[string]json.RawMessage{"watchId": json.RawMessage(`"none"`)})
	if err == nil || err.Error() != "ETCD_WATCH_NOT_FOUND: watch does not exist" {
		t.Fatalf("expected watch-not-found, got %v", err)
	}
}

func TestPutRejectsLeaseOptions(t *testing.T) {
	state := newEtcd2Session()
	// Client check comes first (Java parity); without a connection the error
	// stays "Not connected".
	params := map[string]json.RawMessage{
		"key":   json.RawMessage(`"k"`),
		"value": json.RawMessage(`{"encoding":"utf8","data":"v"}`),
		"ttl":   json.RawMessage(`5`),
		"lease": json.RawMessage(`7`),
	}
	if _, err := state.put(params); err == nil || err.Error() != "Not connected" {
		t.Fatalf("expected Not connected before option validation, got %v", err)
	}
}

func TestPrefixEnd(t *testing.T) {
	if prefixEnd("") != "\x00" || prefixEnd("ab") != "ac" || prefixEnd("a\xff") != "b" {
		t.Fatalf("prefixEnd algorithm broken")
	}
}

func TestValueEncodings(t *testing.T) {
	utf8Value := valueObject([]byte("hello"))
	if utf8Value["encoding"] != "utf8" || utf8Value["data"] != "hello" {
		t.Fatalf("unexpected utf8 value: %#v", utf8Value)
	}
	if valueObject([]byte{0xff})["encoding"] != "base64" {
		t.Fatalf("binary must be base64")
	}
	if displayBytes([]byte{0xff}) == "\xff" {
		t.Fatalf("displayBytes must fall back to base64")
	}
}

func (s *etcd2Session) watchBufferedBytesSnapshot() int64 {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	return s.watchBufferedBytes
}
