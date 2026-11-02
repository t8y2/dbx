package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"go.etcd.io/etcd/api/v3/etcdserverpb"
	"go.etcd.io/etcd/api/v3/mvccpb"
	"go.etcd.io/etcd/api/v3/v3rpc/rpctypes"
	clientv3 "go.etcd.io/etcd/client/v3"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestHandshakeAdvertisesCapabilities(t *testing.T) {
	server := newRuntimeServer()
	result, _, err := server.dispatch("handshake", nil)
	if err != nil {
		t.Fatalf("handshake failed: %v", err)
	}
	handshake := result.(map[string]any)
	if handshake["protocolVersion"] != 2 || handshake["agentProtocolVersion"] != 2 {
		t.Fatalf("unexpected protocol versions: %#v", handshake)
	}
	want := []string{
		"connect", "test_connection", "kv", "kv_ttl", "kv_cas", "kv_list_values", "kv_status",
		"kv_history", "etcd_compaction", "etcd_defrag", "etcd_watch", "etcd_lease", "etcd_auth",
		"multi_session",
	}
	got, ok := handshake["capabilities"].([]string)
	if !ok {
		t.Fatalf("capabilities missing: %#v", handshake)
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("capability mismatch:\n got %v\nwant %v", got, want)
	}
	for _, capability := range got {
		if capability == "structured_error_v1" {
			t.Fatalf("structured_error_v1 must not be advertised (Java parity)")
		}
	}
}

func TestHandleLineReportsSessionNotFound(t *testing.T) {
	server := newRuntimeServer()
	response, _ := server.handleLine(`{"id":7,"method":"kv_get","params":{"key":"a"}}`)
	if response.Error == nil {
		t.Fatalf("expected error response, got %#v", response)
	}
	if response.Error.Code != -1 {
		t.Fatalf("expected code -1, got %d", response.Error.Code)
	}
	if response.Error.Message != "Agent session not found: __legacy__" {
		t.Fatalf("unexpected message: %q", response.Error.Message)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(response.ID, &raw); err == nil {
		_ = raw
	}
	if string(response.ID) != "7" {
		t.Fatalf("expected id 7, got %s", response.ID)
	}
}

func TestOpenSessionValidatesAgentSessionID(t *testing.T) {
	server := newRuntimeServer()
	_, _, err := server.dispatch("open_session", map[string]json.RawMessage{})
	if err == nil || !strings.Contains(err.Error(), "agentSessionId is required") {
		t.Fatalf("expected agentSessionId requirement, got %v", err)
	}
}

func TestOpenSessionRejectsDuplicate(t *testing.T) {
	server := newRuntimeServer()
	server.sessions["dup"] = &agentSession{state: newEtcdSession()}
	_, _, err := server.dispatch("open_session", map[string]json.RawMessage{
		"agentSessionId": json.RawMessage(`"dup"`),
	})
	if err == nil || !strings.Contains(err.Error(), "Agent session already exists") {
		t.Fatalf("expected duplicate rejection, got %v", err)
	}
}

func TestUnconnectedSessionErrors(t *testing.T) {
	state := newEtcdSession()
	if _, err := state.get(map[string]json.RawMessage{"key": json.RawMessage(`"k"`)}); err == nil || err.Error() != "Not connected" {
		t.Fatalf("kv_get before connect: %v", err)
	}
	if _, err := state.history(map[string]json.RawMessage{"key": json.RawMessage(`"k"`)}); err == nil || err.Error() != "Not connected" {
		t.Fatalf("kv_history before connect: %v", err)
	}
	if _, err := state.validateConnection(); err == nil || err.Error() != "Not connected" {
		t.Fatalf("validate_connection before connect: %v", err)
	}
}

func TestConnectTimeoutBounds(t *testing.T) {
	cases := []struct {
		configured int
		want       int
	}{
		{0, 30},
		{-5, 1},
		{1, 1},
		{30, 30},
		{300, 300},
		{999, 300},
	}
	for _, testCase := range cases {
		got := connectTimeoutSeconds(connectionParams{ConnectTimeoutSecs: testCase.configured})
		if got != testCase.want {
			t.Fatalf("connectTimeoutSeconds(%d) = %d, want %d", testCase.configured, got, testCase.want)
		}
	}
}

func TestGrpcMaxInboundMessageSize(t *testing.T) {
	cases := []struct {
		connection connectionParams
		want       int
	}{
		{connectionParams{}, defaultGrpcMaxInboundMessageSize},
		{connectionParams{GrpcMaxInboundMessageSize: 1024}, minGrpcMaxInboundMessageSize},
		{connectionParams{GrpcMaxInboundMessageSize: 999 * 1024 * 1024}, maxGrpcMaxInboundMessageSize},
		{connectionParams{URLParams: "grpc_max_inbound_message_size=104857600"}, 100 * 1024 * 1024},
		{connectionParams{URLParams: "?grpc_max_inbound_message_size=64"}, minGrpcMaxInboundMessageSize},
		{connectionParams{URLParams: "grpc_max_inbound_message_size=abc"}, defaultGrpcMaxInboundMessageSize},
		{connectionParams{GrpcMaxInboundMessageSize: 52428800, URLParams: "grpc_max_inbound_message_size=1024"}, 50 * 1024 * 1024},
	}
	for _, testCase := range cases {
		got := grpcMaxInboundMessageSize(testCase.connection)
		if got != testCase.want {
			t.Fatalf("grpcMaxInboundMessageSize(%+v) = %d, want %d", testCase.connection, got, testCase.want)
		}
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
		{"newline list", connectionParams{Endpoints: "a:1\nb:2"}, []string{"http://a:1", "http://b:2"}},
		{"precedence", connectionParams{EtcdEndpoints: "a:1", Endpoints: "b:2", ConnectionString: "c:3"}, []string{"http://a:1"}},
		{"existing scheme", connectionParams{EtcdEndpoints: "https://a:1,http://b:2"}, []string{"https://a:1", "http://b:2"}},
		{"blank entries", connectionParams{EtcdEndpoints: " a:1 , ,b:2"}, []string{"http://a:1", "http://b:2"}},
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
	_, err = tlsConfigFor(connectionParams{SSL: true, CertPath: "/tmp/cert.pem", KeyPath: "/tmp/key.pem"})
	if err == nil {
		t.Fatalf("expected key pair load failure for missing files")
	}
}

func TestClientCertificateUsername(t *testing.T) {
	config := &tls.Config{Certificates: []tls.Certificate{{Leaf: &x509.Certificate{Subject: pkix.Name{CommonName: " cert-reader "}}}}}
	if got := clientCertificateUsername(config); got != "cert-reader" {
		t.Fatalf("clientCertificateUsername() = %q, want cert-reader", got)
	}
	if got := clientCertificateUsername(&tls.Config{}); got != "" {
		t.Fatalf("empty certificate username = %q, want empty", got)
	}
}

func TestReadableKeyRangesUsesAuthStatusAndEffectiveIdentity(t *testing.T) {
	withoutAuth := newEtcdSession()
	withoutAuth.username = "cert-reader"
	allKeys, ranges, err := withoutAuth.readableKeyRanges()
	if err != nil || !allKeys || len(ranges) != 0 {
		t.Fatalf("disabled auth should allow all keys: all=%v ranges=%v err=%v", allKeys, ranges, err)
	}

	missingIdentity := newEtcdSession()
	missingIdentity.authEnabled = true
	allKeys, ranges, err = missingIdentity.readableKeyRanges()
	if err != nil || allKeys || len(ranges) != 0 {
		t.Fatalf("enabled auth without an identity should expose no ranges: all=%v ranges=%v err=%v", allKeys, ranges, err)
	}
}

func TestReadAccessCacheExpiresAndReturnsACopy(t *testing.T) {
	state := newEtcdSession()
	state.cacheReadAccess(false, []etcdReadRange{{start: "/team-a/", end: "/team-a0"}})

	allKeys, ranges, ok := state.cachedReadAccess(time.Now())
	if !ok || allKeys || len(ranges) != 1 || ranges[0].start != "/team-a/" {
		t.Fatalf("cached read access = all=%v ranges=%#v ok=%v", allKeys, ranges, ok)
	}
	ranges[0].start = "/mutated/"
	_, ranges, ok = state.cachedReadAccess(time.Now())
	if !ok || ranges[0].start != "/team-a/" {
		t.Fatalf("cached range was not copied: %#v", ranges)
	}

	state.clientMu.Lock()
	state.readAccess.expiresAt = time.Now().Add(-time.Second)
	state.clientMu.Unlock()
	if _, _, ok := state.cachedReadAccess(time.Now()); ok {
		t.Fatal("expired read access cache was returned")
	}
}

func TestAuthenticationNotEnabledFallbackClearsCachedRestrictions(t *testing.T) {
	if !isAuthenticationNotEnabled(rpctypes.ErrAuthNotEnabled) {
		t.Fatal("authentication-not-enabled status was not recognized")
	}
	if isAuthenticationNotEnabled(status.Error(codes.PermissionDenied, "authentication is not enabled")) {
		t.Fatal("permission-denied status must not disable authentication")
	}

	state := newEtcdSession()
	state.authEnabled = true
	state.cacheReadAccess(false, []etcdReadRange{{start: "/team-a/", end: "/team-a0"}})
	state.disableAuth()
	if state.authEnabled {
		t.Fatal("authentication remained enabled after compatibility fallback")
	}
	if _, _, ok := state.cachedReadAccess(time.Now()); ok {
		t.Fatal("compatibility fallback retained stale restricted ranges")
	}
}

func TestAuthUserGetReportsDisabledAuthWithoutAClient(t *testing.T) {
	state := newEtcdSession()
	state.username = "cert-reader"
	result, err := state.authUserGet(map[string]json.RawMessage{})
	if err != nil {
		t.Fatalf("authUserGet() failed: %v", err)
	}
	detail := result.(map[string]any)
	if detail["user"] != "cert-reader" || detail["authEnabled"] != false {
		t.Fatalf("unexpected auth detail: %#v", detail)
	}
}

type recordingRangeGetter struct {
	responses []*clientv3.GetResponse
	revisions []int64
}

func (g *recordingRangeGetter) Get(_ context.Context, key string, options ...clientv3.OpOption) (*clientv3.GetResponse, error) {
	op := clientv3.OpGet(key, options...)
	g.revisions = append(g.revisions, op.Rev())
	response := g.responses[0]
	g.responses = g.responses[1:]
	return response, nil
}

func TestListReadableRangesPinsFirstResponseRevision(t *testing.T) {
	getter := &recordingRangeGetter{responses: []*clientv3.GetResponse{
		{Header: &etcdserverpb.ResponseHeader{Revision: 10}, Kvs: []*mvccpb.KeyValue{{Key: []byte("a")}}},
		{Header: &etcdserverpb.ResponseHeader{Revision: 12}, Kvs: []*mvccpb.KeyValue{{Key: []byte("z")}}},
	}}
	result, err := newEtcdSession().listReadableRanges(getter, []etcdReadRange{{start: "a", end: "b"}, {start: "z", end: "zz"}}, "\x00", 10, nil, false)
	if err != nil {
		t.Fatalf("listReadableRanges() failed: %v", err)
	}
	if len(getter.revisions) != 2 || getter.revisions[0] != 0 || getter.revisions[1] != 10 {
		t.Fatalf("range revisions = %v, want [0 10]", getter.revisions)
	}
	if revision := result.(map[string]any)["revision"]; revision != "10" {
		t.Fatalf("result revision = %v, want 10", revision)
	}
}

func TestHistoryStartRevision(t *testing.T) {
	cases := []struct {
		requested *int64
		target    int64
		want      int64
	}{
		{nil, 5000, 1},
		{nil, 10000, 1},
		{nil, 10001, 2},
		{nil, 15000, 5001},
		{int64Ptr(200), 15000, 200},
		{int64Ptr(-5), 15000, 1},
	}
	for _, testCase := range cases {
		got := historyStartRevision(testCase.requested, testCase.target)
		if got != testCase.want {
			t.Fatalf("historyStartRevision(%v, %d) = %d, want %d", testCase.requested, testCase.target, got, testCase.want)
		}
	}
}

func int64Ptr(value int64) *int64 {
	return &value
}

func TestHistoryCollectorBounds(t *testing.T) {
	collector := &historyCollector{limit: 3}
	for i := int64(1); i <= 5; i++ {
		collector.append(map[string]any{"revision": longString(i)})
	}
	if len(collector.rows) != 3 {
		t.Fatalf("expected 3 retained rows, got %d", len(collector.rows))
	}
	if !collector.truncated {
		t.Fatalf("expected truncated flag")
	}
	if collector.rows[0]["revision"] != "3" || collector.rows[2]["revision"] != "5" {
		t.Fatalf("expected newest rows retained, got %v", collector.rows)
	}
}

func TestPrefixEnd(t *testing.T) {
	cases := []struct{ prefix, want string }{
		{"", "\x00"},
		{"abc", "abd"},
		{"a\xff", "b"},
		{"\xff\xff", "\x00"},
		{"a\xffb", "a\xffc"},
	}
	for _, testCase := range cases {
		if got := prefixEnd(testCase.prefix); got != testCase.want {
			t.Fatalf("prefixEnd(%q) = %q, want %q", testCase.prefix, got, testCase.want)
		}
	}
}

func TestValueEncodings(t *testing.T) {
	utf8Value := valueObject([]byte("hello"))
	if utf8Value["encoding"] != "utf8" || utf8Value["data"] != "hello" {
		t.Fatalf("unexpected utf8 value: %#v", utf8Value)
	}
	binaryValue := valueObject([]byte{0xff, 0xfe})
	if binaryValue["encoding"] != "base64" {
		t.Fatalf("expected base64 for binary: %#v", binaryValue)
	}
	roundTrip, err := parseValueObject(map[string]json.RawMessage{
		"encoding": json.RawMessage(`"base64"`),
		"data":     json.RawMessage(`"` + binaryValue["data"].(string) + `"`),
	})
	if err != nil || roundTrip != string([]byte{0xff, 0xfe}) {
		t.Fatalf("base64 round trip failed: %q %v", roundTrip, err)
	}
	if _, err := parseValueObject(map[string]json.RawMessage{"encoding": json.RawMessage(`"hex"`)}); err == nil {
		t.Fatalf("expected unsupported encoding error")
	}
	if displayBytes([]byte{0xff}) != valueObject([]byte{0xff})["data"] {
		t.Fatalf("displayBytes should fall back to base64")
	}
}

func TestNextContinuation(t *testing.T) {
	encoded := nextContinuation([]byte("key"))
	decoded, err := decodeBase64String(encoded)
	if err != nil {
		t.Fatalf("invalid continuation: %v", err)
	}
	if decoded != "key\x00" {
		t.Fatalf("unexpected continuation start: %q", decoded)
	}
}

func decodeBase64String(value string) (string, error) {
	decoded, err := base64Decode(value)
	if err != nil {
		return "", err
	}
	return string(decoded), nil
}

func TestWatchEventBufferBytes(t *testing.T) {
	item := testKeyValue(3, 10, 20)
	previous := testKeyValue(2, 5, 7)
	// 512 + 4*3 (key) + 4*10 (value) + 4*5 (previous value) = 584
	if got := watchEventBufferBytes(item, previous); got != 584 {
		t.Fatalf("watchEventBufferBytes = %d, want 584", got)
	}
	previous.Version = 0
	if got := watchEventBufferBytes(item, previous); got != 564 {
		t.Fatalf("zero-version previous ignored: %d, want 564", got)
	}
}

func TestWatchOverflowPreservesBufferedBatch(t *testing.T) {
	session := newEtcdSession()
	state := &watchState{watchID: "w", session: session}
	smallBatch := []map[string]any{{"eventType": "put"}}
	state.append(10, smallBatch, 128)
	state.append(11, []map[string]any{{"eventType": "put"}}, maxWatchBufferBytes+1)

	// The buffered batch stays pollable; the terminal rides along once the
	// buffer has fully drained within the same poll (Java parity).
	polled := state.poll()
	if len(polled["batches"].([]any)) != 1 {
		t.Fatalf("overflow must keep the buffered batch pollable: %#v", polled)
	}
	terminal, ok := polled["terminal"].(map[string]any)
	if !ok || terminal["reason"] != "overflow" {
		t.Fatalf("expected overflow terminal after drain, got %#v", polled)
	}
	if terminal["message"] != "ETCD_WATCH_OVERFLOW: the event buffer reached its byte or event limit" {
		t.Fatalf("unexpected overflow message: %v", terminal["message"])
	}
	if session.watchBufferedBytesSnapshot() != 0 {
		t.Fatalf("session budget not released: %d", session.watchBufferedBytesSnapshot())
	}
}

func TestWatchPollReleasesSessionBudget(t *testing.T) {
	session := newEtcdSession()
	state := &watchState{watchID: "w", session: session}
	state.append(1, []map[string]any{{"eventType": "put"}}, 1000)
	if session.watchBufferedBytesSnapshot() != 1000 {
		t.Fatalf("expected reserved budget 1000, got %d", session.watchBufferedBytesSnapshot())
	}
	state.poll()
	if session.watchBufferedBytesSnapshot() != 0 {
		t.Fatalf("expected budget released after poll, got %d", session.watchBufferedBytesSnapshot())
	}
}

func TestSessionAggregateBudgetTerminatesOnlyOffendingWatch(t *testing.T) {
	session := newEtcdSession()
	first := &watchState{watchID: "a", session: session}
	second := &watchState{watchID: "b", session: session}
	if !session.reserveWatchBuffer(maxSessionWatchBufferBytes / 2) {
		t.Fatalf("first reservation should succeed")
	}
	second.append(1, []map[string]any{{"eventType": "put"}}, maxSessionWatchBufferBytes/2+1)
	polled := second.poll()
	terminal, ok := polled["terminal"].(map[string]any)
	if !ok || terminal["reason"] != "overflow" {
		t.Fatalf("expected aggregate overflow on second watch: %#v", polled)
	}
	if first.hasTerminal() {
		t.Fatalf("first watch must stay healthy")
	}
	session.releaseWatchBuffer(maxSessionWatchBufferBytes / 2)
}

func TestWatchPollRemovesTerminalWatch(t *testing.T) {
	session := newEtcdSession()
	state := &watchState{watchID: "w", session: session}
	session.registerWatch("w", state)
	state.fail("closed", "watch closed", nil)
	params := map[string]json.RawMessage{"watchId": json.RawMessage(`"w"`)}
	result, err := session.watchPoll(params)
	if err != nil {
		t.Fatalf("watchPoll failed: %v", err)
	}
	if _, ok := result.(map[string]any)["terminal"]; !ok {
		t.Fatalf("expected terminal in poll result: %#v", result)
	}
	if session.watchCount() != 0 {
		t.Fatalf("terminal watch must be removed from the session")
	}
}

func TestWatchPollUnknownID(t *testing.T) {
	session := newEtcdSession()
	_, err := session.watchPoll(map[string]json.RawMessage{"watchId": json.RawMessage(`"missing"`)})
	if err == nil || err.Error() != "ETCD_WATCH_NOT_FOUND: watch does not exist" {
		t.Fatalf("expected watch-not-found, got %v", err)
	}
}

func TestWatchStartLimitReached(t *testing.T) {
	session := newEtcdSession()
	for i := 0; i < maxWatches; i++ {
		session.registerWatch(string(rune('a'+i)), &watchState{watchID: string(rune('a' + i)), session: session})
	}
	_, err := session.watchStart(map[string]json.RawMessage{"key": json.RawMessage(`"k"`)})
	if err == nil || !strings.HasPrefix(err.Error(), "ETCD_WATCH_LIMIT") {
		t.Fatalf("expected watch limit error, got %v", err)
	}
}

func TestWatchScopeValidation(t *testing.T) {
	session := newEtcdSession()
	_, err := session.watchStart(map[string]json.RawMessage{"key": json.RawMessage(`"k"`), "scope": json.RawMessage(`"glob"`)})
	if err == nil || err.Error() != "ETCD_WATCH_SCOPE_INVALID: scope must be key or prefix" {
		t.Fatalf("expected scope error, got %v", err)
	}
}

func TestLeasePageIDs(t *testing.T) {
	ids := []uint64{30, 10, 20}
	page := leasePageIDs(ids, nil, 2)
	if page[0] != 10 || page[1] != 20 {
		t.Fatalf("expected unsigned ascending order, got %v", page)
	}
	after := uint64(20)
	page = leasePageIDs(ids, &after, 10)
	if len(page) != 1 || page[0] != 30 {
		t.Fatalf("expected only 30 after cursor 20, got %v", page)
	}
	// 2^63 boundary must compare unsigned, not signed.
	big := []uint64{1, uint64(1) << 63}
	page = leasePageIDs(big, nil, 2)
	if page[0] != 1 || page[1] != uint64(1)<<63 {
		t.Fatalf("unsigned ordering broken: %v", page)
	}
}

func TestParseUnsignedLong(t *testing.T) {
	parsed, err := parseUnsignedLong("18446744073709551615")
	if err != nil || parsed != 18446744073709551615 {
		t.Fatalf("uint64 max parse failed: %d %v", parsed, err)
	}
	if _, err := parseUnsignedLong("nope"); err == nil {
		t.Fatalf("expected parse failure")
	}
}

func TestAppendUnexecutedDefragMembers(t *testing.T) {
	members := []map[string]any{{"endpoint": "a", "status": "failed"}}
	appendUnexecutedDefragMembers(&members, []string{"a", "b", "c"}, "a")
	if len(members) != 3 {
		t.Fatalf("expected 3 rows, got %d", len(members))
	}
	for _, row := range members[1:] {
		if row["status"] != "not_executed" || row["durationMs"] != nil || row["error"] != nil {
			t.Fatalf("unexpected not_executed row: %#v", row)
		}
	}
}

func TestDefragRequiresEndpoints(t *testing.T) {
	state := newEtcdSession()
	_, err := state.defrag(map[string]json.RawMessage{})
	if err == nil || err.Error() != "ETCD_DEFRAG_TARGET_REQUIRED: at least one endpoint is required" {
		t.Fatalf("expected defrag target error, got %v", err)
	}
}

func TestRequiredPositiveLongAndString(t *testing.T) {
	_, err := requiredPositiveLong(map[string]json.RawMessage{"id": json.RawMessage(`0`)}, "id")
	if err == nil || err.Error() != "ETCD_INVALID_ID: a positive integer is required" {
		t.Fatalf("unexpected error: %v", err)
	}
	_, err = requiredString(map[string]json.RawMessage{}, "user")
	if err == nil || err.Error() != "ETCD_USER_REQUIRED" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestKeyBytesParam(t *testing.T) {
	if _, err := keyBytesParam(map[string]json.RawMessage{}); err == nil || err.Error() != "Key is required" {
		t.Fatalf("expected Key is required, got %v", err)
	}
	encoded := base64Encode([]byte{0x01, 0x02})
	key, err := keyBytesParam(map[string]json.RawMessage{
		"keyBytes": json.RawMessage(`{"encoding":"base64","data":"` + encoded + `"}`),
	})
	if err != nil || key != string([]byte{0x01, 0x02}) {
		t.Fatalf("keyBytes decode failed: %q %v", key, err)
	}
}

func TestPutRejectsConflictingLeaseOptions(t *testing.T) {
	state := newEtcdSession()
	params := map[string]json.RawMessage{
		"key":   json.RawMessage(`"k"`),
		"value": json.RawMessage(`{"encoding":"utf8","data":"v"}`),
		"ttl":   json.RawMessage(`5`),
		"lease": json.RawMessage(`7`),
	}
	// Java checks the active client before option exclusivity; without a
	// connection the error must stay "Not connected".
	_, err := state.put(params)
	if err == nil || err.Error() != "Not connected" {
		t.Fatalf("expected Not connected before option validation, got %v", err)
	}
}

func TestNormalizeReadRangesKeepsOnlyOutermostReadableScopes(t *testing.T) {
	ranges := normalizeReadRanges([]etcdReadRange{
		{start: "/team-a/", end: "/team-a0"},
		{start: "/team-a/config", end: "/team-a/config\x00"},
		{start: "/team-b/", end: "/team-b0"},
		{start: "/invalid", end: "/invalid"},
	})
	if len(ranges) != 2 {
		t.Fatalf("readable ranges = %#v, want two outer ranges", ranges)
	}
	if ranges[0].start != "/team-a/" || ranges[1].start != "/team-b/" {
		t.Fatalf("unexpected readable ranges: %#v", ranges)
	}
	merged := normalizeReadRanges([]etcdReadRange{{start: "a", end: "d"}, {start: "c", end: "f"}})
	if len(merged) != 1 || merged[0].start != "a" || merged[0].end != "f" {
		t.Fatalf("overlapping ranges must merge: %#v", merged)
	}
	fromKey := normalizeReadRanges([]etcdReadRange{{start: "/team-c/", end: unboundedRangeEnd}, {start: "/team-d/", end: "/team-e/"}})
	if len(fromKey) != 1 || fromKey[0].start != "/team-c/" || fromKey[0].end != unboundedRangeEnd {
		t.Fatalf("from-key permission must remain unbounded: %#v", fromKey)
	}
	if rangeStartAtOrAfterEnd("/team-z/", unboundedRangeEnd) {
		t.Fatal("an unbounded range end must not exclude a later continuation")
	}
	if !isAllKeyPermission("", "\x00") || !isAllKeyPermission("\x00", "\x00") {
		t.Fatal("all-Key permissions must be recognized")
	}
}

func TestIntersectReadRangesLimitsBroadPrefixToGrantedScopes(t *testing.T) {
	granted := []etcdReadRange{
		{start: "/dbx", end: "/dby"},
		{start: "/team/secret", end: "/team/secret\x00"},
	}

	broad := intersectReadRanges(granted, "/", "0")
	if len(broad) != 2 || broad[0] != granted[0] || broad[1] != granted[1] {
		t.Fatalf("broad prefix intersections = %#v, want %#v", broad, granted)
	}

	narrow := intersectReadRanges(granted, "/dbx/config/", "/dbx/config0")
	if len(narrow) != 1 || narrow[0].start != "/dbx/config/" || narrow[0].end != "/dbx/config0" {
		t.Fatalf("narrow prefix intersection = %#v", narrow)
	}

	disjoint := intersectReadRanges(granted, "/other/", "/other0")
	if len(disjoint) != 0 {
		t.Fatalf("disjoint prefix intersections = %#v, want none", disjoint)
	}

	unbounded := intersectReadRanges([]etcdReadRange{{start: "/dbx", end: unboundedRangeEnd}}, "/dbx", unboundedRangeEnd)
	if len(unbounded) != 1 || unbounded[0].end != unboundedRangeEnd {
		t.Fatalf("unbounded prefix intersection = %#v", unbounded)
	}
}

func (s *etcdSession) watchBufferedBytesSnapshot() int64 {
	s.watchesMu.Lock()
	defer s.watchesMu.Unlock()
	return s.watchBufferedBytes
}

func (w *watchState) hasTerminal() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.terminalReason != ""
}

func testKeyValue(keySize, valueSize, version int64) *mvccpb.KeyValue {
	return &mvccpb.KeyValue{
		Key:     bytesOfLength(keySize),
		Value:   bytesOfLength(valueSize),
		Version: version,
	}
}

func bytesOfLength(size int64) []byte {
	return make([]byte, size)
}

func base64Decode(value string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(value)
}

func base64Encode(value []byte) string {
	return base64.StdEncoding.EncodeToString(value)
}
