package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLiveEtcd2Agent exercises the v2 agent surface against a real etcd 2.x
// server. Enable with DBX_ETCD2_LIVE=1; configure via DBX_ETCD2_ENDPOINTS,
// DBX_ETCD2_USER, and DBX_ETCD2_PASSWORD (defaults match the server
// deployment: root/123456).
func TestLiveEtcd2Agent(t *testing.T) {
	if os.Getenv("DBX_ETCD2_LIVE") != "1" {
		t.Skip("set DBX_ETCD2_LIVE=1 to run the live etcd v2 agent test")
	}
	endpoints := envOrDefault("DBX_ETCD2_ENDPOINTS", "http://172.26.129.83:20041")
	user := envOrDefault("DBX_ETCD2_USER", "root")
	password := envOrDefault("DBX_ETCD2_PASSWORD", "123456")

	state := newEtcd2Session()
	connectParams := map[string]json.RawMessage{
		"etcd_endpoints": json.RawMessage(`"` + endpoints + `"`),
		"username":       json.RawMessage(`"` + user + `"`),
		"password":       json.RawMessage(`"` + password + `"`),
	}
	if _, err := state.connect(connectParams); err != nil {
		t.Fatalf("connect failed: %v", err)
	}
	defer state.close()

	if result, err := state.validateConnection(); err != nil {
		t.Fatalf("validate_connection failed: %v", err)
	} else if probe := result.(map[string]any); probe["ok"] != true {
		t.Fatalf("unexpected probe result: %#v", probe)
	}

	prefix := fmt.Sprintf("/dbx/live/%d/", time.Now().UnixNano())

	// --- KV basics -----------------------------------------------------
	if _, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":   jsonString(prefix + "hello"),
		"value": jsonValue("world"),
	})); err != nil {
		t.Fatalf("put failed: %v", err)
	}
	fetched, err := state.get(paramsWith(map[string]json.RawMessage{"key": jsonString(prefix + "hello")}))
	if err != nil {
		t.Fatalf("get failed: %v", err)
	}
	row := fetched.(map[string]any)
	if row["found"] != true || row["key"] != prefix+"hello" {
		t.Fatalf("unexpected get result: %#v", row)
	}
	value := row["value"].(map[string]any)
	if value["encoding"] != "utf8" || value["data"] != "world" {
		t.Fatalf("unexpected value: %#v", value)
	}
	metadata := row["metadata"].(map[string]any)
	if metadata["createRevision"] != metadata["modRevision"] {
		t.Fatalf("fresh key indexes should match: %#v", metadata)
	}

	missing, err := state.get(paramsWith(map[string]json.RawMessage{"key": jsonString(prefix + "missing")}))
	if err != nil {
		t.Fatalf("missing get failed: %v", err)
	}
	if missing.(map[string]any)["found"] != false {
		t.Fatalf("expected found=false: %#v", missing)
	}

	// CAS conflict on stale index.
	if _, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":                 jsonString(prefix + "hello"),
		"value":               jsonValue("v2"),
		"expectedModRevision": json.RawMessage(`1`),
	})); err == nil || err.Error() != "ETCD_CAS_CONFLICT: key changed after it was loaded" {
		t.Fatalf("expected CAS conflict, got %v", err)
	}
	if _, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":                 jsonString(prefix + "hello"),
		"value":               jsonValue("v3"),
		"expectedModRevision": json.RawMessage(metadata["modRevision"].(string)),
	})); err != nil {
		t.Fatalf("CAS put failed: %v", err)
	}

	// TTL put and metadata.
	if _, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":   jsonString(prefix + "leased"),
		"value": jsonValue("expiring"),
		"ttl":   json.RawMessage(`300`),
	})); err != nil {
		t.Fatalf("ttl put failed: %v", err)
	}
	leased, err := state.get(paramsWith(map[string]json.RawMessage{"key": jsonString(prefix + "leased")}))
	if err != nil {
		t.Fatalf("leased get failed: %v", err)
	}
	if _, hasTTL := leased.(map[string]any)["metadata"].(map[string]any)["ttl"]; !hasTTL {
		t.Fatalf("leased key must expose ttl metadata: %#v", leased)
	}

	// Lease objects are a v3 concept and must be rejected clearly.
	if _, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":   jsonString(prefix + "nolease"),
		"value": jsonValue("v"),
		"lease": json.RawMessage(`5`),
	})); err == nil || !strings.HasPrefix(err.Error(), "ETCD_V2_LEASE_UNSUPPORTED") {
		t.Fatalf("expected lease rejection, got %v", err)
	}

	// Rename including conflict and missing-source paths.
	if _, err := state.rename(paramsWith(map[string]json.RawMessage{
		"key":    jsonString(prefix + "old"),
		"newKey": jsonString(prefix + "new"),
	})); err == nil || err.Error() != "ETCD_NOT_FOUND: source key does not exist" {
		t.Fatalf("expected rename not-found, got %v", err)
	}
	if _, err := state.rename(paramsWith(map[string]json.RawMessage{
		"key":    jsonString(prefix + "hello"),
		"newKey": jsonString(prefix + "renamed"),
	})); err != nil {
		t.Fatalf("rename failed: %v", err)
	}
	renamed, err := state.get(paramsWith(map[string]json.RawMessage{"key": jsonString(prefix + "renamed")}))
	if err != nil || renamed.(map[string]any)["found"] != true {
		t.Fatalf("rename target missing: %#v %v", renamed, err)
	}
	if renamed.(map[string]any)["value"].(map[string]any)["data"] != "v3" {
		t.Fatalf("rename must carry the value: %#v", renamed)
	}
	source, err := state.get(paramsWith(map[string]json.RawMessage{"key": jsonString(prefix + "hello")}))
	if err != nil || source.(map[string]any)["found"] != false {
		t.Fatalf("rename must remove the source: %#v %v", source, err)
	}
	if _, err := state.rename(paramsWith(map[string]json.RawMessage{
		"key":    jsonString(prefix + "leased"),
		"newKey": jsonString(prefix + "renamed"),
	})); err == nil || err.Error() != "ETCD_CAS_CONFLICT: source changed or target already exists" {
		t.Fatalf("expected rename conflict, got %v", err)
	}

	// list_prefix with continuation.
	for i := 0; i < 3; i++ {
		if _, err := state.put(paramsWith(map[string]json.RawMessage{
			"key":   jsonString(fmt.Sprintf("%sbulk%d", prefix, i)),
			"value": jsonValue(fmt.Sprintf("v%d", i)),
		})); err != nil {
			t.Fatalf("bulk put %d failed: %v", i, err)
		}
	}
	listed, err := state.listPrefix(paramsWith(map[string]json.RawMessage{
		"prefix":        jsonString(prefix),
		"limit":         json.RawMessage(`2`),
		"includeValues": json.RawMessage(`true`),
	}))
	if err != nil {
		t.Fatalf("list_prefix failed: %v", err)
	}
	list := listed.(map[string]any)
	if len(list["keys"].([]any)) != 2 {
		t.Fatalf("expected limited list, got %#v", list)
	}
	continuation, ok := list["continuation"].(string)
	if !ok || continuation == "" {
		t.Fatalf("expected continuation, got %#v", list)
	}
	nextPage, err := state.listPrefix(paramsWith(map[string]json.RawMessage{
		"prefix":        jsonString(prefix),
		"limit":         json.RawMessage(`100`),
		"includeValues": json.RawMessage(`true`),
		"continuation":  json.RawMessage(`"` + continuation + `"`),
	}))
	if err != nil {
		t.Fatalf("continuation list failed: %v", err)
	}
	nextKeys := nextPage.(map[string]any)["keys"].([]any)
	if len(nextKeys) == 0 {
		t.Fatalf("continuation must resume after the first page")
	}
	if nextKeys[0].(map[string]any)["key"].(string) == list["keys"].([]any)[1].(map[string]any)["key"].(string) {
		t.Fatalf("continuation overlapped the first page")
	}

	// --- watch (long poll) --------------------------------------------
	watchStarted, err := state.watchStart(paramsWith(map[string]json.RawMessage{
		"key":           jsonString(prefix + "watched"),
		"includePrevKv": json.RawMessage(`true`),
	}))
	if err != nil {
		t.Fatalf("watch_start failed: %v", err)
	}
	watchID := watchStarted.(map[string]any)["watchId"].(string)
	if _, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":   jsonString(prefix + "watched"),
		"value": jsonValue("first"),
	})); err != nil {
		t.Fatalf("watched put failed: %v", err)
	}
	if _, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":   jsonString(prefix + "watched"),
		"value": jsonValue("second"),
	})); err != nil {
		t.Fatalf("watched put 2 failed: %v", err)
	}
	deadline := time.Now().Add(20 * time.Second)
	var watchBatches []any
	for time.Now().Before(deadline) {
		polled, err := state.watchPoll(paramsWith(map[string]json.RawMessage{"watchId": json.RawMessage(`"` + watchID + `"`)}))
		if err != nil {
			t.Fatalf("watch_poll failed: %v", err)
		}
		batches := polled.(map[string]any)["batches"].([]any)
		watchBatches = append(watchBatches, batches...)
		if len(watchBatches) >= 2 {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	if len(watchBatches) < 2 {
		t.Fatalf("watch did not deliver both events: %#v", watchBatches)
	}
	lastBatch := watchBatches[len(watchBatches)-1].(map[string]any)
	lastEvent := lastBatch["events"].([]map[string]any)[0]
	if lastEvent["value"].(map[string]any)["data"] != "second" {
		t.Fatalf("unexpected last watch event: %#v", lastEvent)
	}
	if lastEvent["previousValue"].(map[string]any)["data"] != "first" {
		t.Fatalf("prevKv missing on watch event: %#v", lastEvent)
	}
	stopped, err := state.watchStop(paramsWith(map[string]json.RawMessage{"watchId": json.RawMessage(`"` + watchID + `"`)}))
	if err != nil || stopped.(map[string]bool)["stopped"] != true {
		t.Fatalf("watch_stop failed: %#v %v", stopped, err)
	}

	// --- auth ----------------------------------------------------------
	userName := fmt.Sprintf("dbxlive%d", time.Now().UnixNano()%100000)
	// Idempotent pre-cleanup: an interrupted earlier run may have left the
	// fixed-named role behind.
	_, _ = state.authRoleDelete(paramsWith(map[string]json.RawMessage{"role": jsonString("dbx_live_role")}))
	if _, err := state.authUserAdd(paramsWith(map[string]json.RawMessage{
		"user":     jsonString(userName),
		"password": jsonString("secret123"),
	})); err != nil {
		t.Fatalf("user add failed: %v", err)
	}
	if _, err := state.authRoleAdd(paramsWith(map[string]json.RawMessage{"role": jsonString("dbx_live_role")})); err != nil {
		t.Fatalf("role add failed: %v", err)
	}
	if _, err := state.authRolePermission(paramsWith(map[string]json.RawMessage{
		"role":     jsonString("dbx_live_role"),
		"resource": jsonString("prefix"),
		"key":      jsonString(prefix),
		"access":   jsonString("READWRITE"),
	}), true); err != nil {
		t.Fatalf("role grant permission failed: %v", err)
	}
	roleDetail, err := state.authRoleGet(paramsWith(map[string]json.RawMessage{"role": jsonString("dbx_live_role")}))
	if err != nil {
		t.Fatalf("role get failed: %v", err)
	}
	permissions := roleDetail.(map[string]any)["permissions"].([]map[string]any)
	if len(permissions) == 0 {
		t.Fatalf("expected permission rows after grant: %#v", roleDetail)
	}
	if _, err := state.authUserGrantRevokeRole(paramsWith(map[string]json.RawMessage{
		"user": jsonString(userName),
		"role": jsonString("dbx_live_role"),
	}), true); err != nil {
		t.Fatalf("grant role failed: %v", err)
	}
	userDetail, err := state.authUserGet(paramsWith(map[string]json.RawMessage{"user": jsonString(userName)}))
	if err != nil {
		t.Fatalf("user get failed: %v", err)
	}
	if len(userDetail.(map[string]any)["roles"].([]string)) == 0 {
		t.Fatalf("expected granted role: %#v", userDetail)
	}
	users, err := state.authUserList(paramsWith(map[string]json.RawMessage{}))
	if err != nil {
		t.Fatalf("user list failed: %v", err)
	}
	if !containsAny(users.(map[string]any)["users"].([]string), userName) {
		t.Fatalf("user list missing created user: %#v", users)
	}
	roles, err := state.authRoleList(paramsWith(map[string]json.RawMessage{}))
	if err != nil || !containsAny(roles.(map[string]any)["roles"].([]string), "dbx_live_role") {
		t.Fatalf("role list missing role: %#v %v", roles, err)
	}
	if _, err := state.authRolePermission(paramsWith(map[string]json.RawMessage{
		"role":     jsonString("dbx_live_role"),
		"resource": jsonString("prefix"),
		"key":      jsonString(prefix),
	}), false); err != nil {
		t.Fatalf("role revoke permission failed: %v", err)
	}
	afterRevoke, err := state.authRoleGet(paramsWith(map[string]json.RawMessage{"role": jsonString("dbx_live_role")}))
	if err != nil {
		t.Fatalf("role get after revoke failed: %v", err)
	}
	if len(afterRevoke.(map[string]any)["permissions"].([]map[string]any)) != 0 {
		t.Fatalf("permissions must be empty after revoke: %#v", afterRevoke)
	}
	if _, err := state.authUserGrantRevokeRole(paramsWith(map[string]json.RawMessage{
		"user": jsonString(userName),
		"role": jsonString("dbx_live_role"),
	}), false); err != nil {
		t.Fatalf("revoke role failed: %v", err)
	}
	if _, err := state.authUserChangePassword(paramsWith(map[string]json.RawMessage{
		"user":     jsonString(userName),
		"password": jsonString("rotated456"),
	})); err != nil {
		t.Fatalf("change password failed: %v", err)
	}
	if _, err := state.authUserDelete(paramsWith(map[string]json.RawMessage{"user": jsonString(userName)})); err != nil {
		t.Fatalf("user delete failed: %v", err)
	}
	if _, err := state.authRoleDelete(paramsWith(map[string]json.RawMessage{"role": jsonString("dbx_live_role")})); err != nil {
		t.Fatalf("role delete failed: %v", err)
	}

	// --- status --------------------------------------------------------
	status, err := state.status(paramsWith(map[string]json.RawMessage{}))
	if err != nil {
		t.Fatalf("kv_status failed: %v", err)
	}
	statusRow := status.(map[string]any)
	if statusRow["clusterId"] == nil || statusRow["leaderId"] == nil {
		t.Fatalf("status missing cluster identity: %#v", statusRow)
	}
	members := statusRow["members"].([]map[string]any)
	if len(members) == 0 || members[0]["reachable"] != true {
		t.Fatalf("unexpected member rows: %#v", members)
	}

	// --- delete + cleanup ----------------------------------------------
	for _, key := range []string{prefix + "leased", prefix + "renamed", prefix + "watched", prefix + "bulk0", prefix + "bulk1", prefix + "bulk2"} {
		if _, err := state.delete(paramsWith(map[string]json.RawMessage{"key": jsonString(key)})); err != nil {
			t.Fatalf("delete %s failed: %v", key, err)
		}
	}
}

func TestLiveEtcd2ProtocolFlow(t *testing.T) {
	if os.Getenv("DBX_ETCD2_LIVE") != "1" {
		t.Skip("set DBX_ETCD2_LIVE=1 to run the live etcd v2 agent test")
	}
	endpoints := envOrDefault("DBX_ETCD2_ENDPOINTS", "http://172.26.129.83:20041")
	user := envOrDefault("DBX_ETCD2_USER", "root")
	password := envOrDefault("DBX_ETCD2_PASSWORD", "123456")

	server := newRuntimeServer()
	connection := fmt.Sprintf(`{"etcd_endpoints":%q,"username":%q,"password":%q}`, endpoints, user, password)

	handshake, _ := server.handleLine(`{"id":1,"method":"handshake","params":{}}`)
	if handshake.Error != nil {
		t.Fatalf("handshake failed: %#v", handshake)
	}
	openLine := fmt.Sprintf(`{"id":2,"method":"open_session","params":{"agentSessionId":"s1","connection":%s}}`, connection)
	opened, _ := server.handleLine(openLine)
	if opened.Error != nil {
		t.Fatalf("open_session failed: %#v", opened)
	}
	putLine := fmt.Sprintf(`{"id":3,"method":"kv_put","params":{"agentSessionId":"s1","key":"/dbx:proto","value":{"encoding":"utf8","data":"flow"}}}`)
	put, _ := server.handleLine(putLine)
	if put.Error != nil {
		t.Fatalf("kv_put failed: %#v", put)
	}
	v3Only, _ := server.handleLine(`{"id":4,"method":"kv_history","params":{"agentSessionId":"s1","key":"/dbx:proto"}}`)
	if v3Only.Error == nil || !strings.HasPrefix(v3Only.Error.Message, "ETCD_V2_UNSUPPORTED") {
		t.Fatalf("expected ETCD_V2_UNSUPPORTED, got %#v", v3Only)
	}
	closed, _ := server.handleLine(`{"id":5,"method":"close_session","params":{"agentSessionId":"s1"}}`)
	if closed.Error != nil {
		t.Fatalf("close_session failed: %#v", closed)
	}
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func paramsWith(params map[string]json.RawMessage) map[string]json.RawMessage {
	return params
}

func jsonString(value string) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return json.RawMessage(encoded)
}

func jsonValue(value string) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return json.RawMessage(`{"encoding":"utf8","data":` + string(encoded) + `}`)
}

func containsAny(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
