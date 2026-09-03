package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLiveEtcdAgent exercises the full agent surface against a real etcd
// server. Enable with DBX_ETCD_LIVE=1; configure via DBX_ETCD_ENDPOINTS,
// DBX_ETCD_USER, and DBX_ETCD_PASSWORD (defaults match the deploy recipes:
// root/123456 on 127.0.0.1:10700 for 3.7).
func TestLiveEtcdAgent(t *testing.T) {
	if os.Getenv("DBX_ETCD_LIVE") != "1" {
		t.Skip("set DBX_ETCD_LIVE=1 to run the live etcd agent test")
	}
	endpoints := envOrDefault("DBX_ETCD_ENDPOINTS", "http://127.0.0.1:10700")
	user := envOrDefault("DBX_ETCD_USER", "root")
	password := envOrDefault("DBX_ETCD_PASSWORD", "123456")

	state := newEtcdSession()
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
	} else {
		probe := result.(map[string]any)
		if probe["ok"] != true {
			t.Fatalf("unexpected probe result: %#v", probe)
		}
	}

	prefix := fmt.Sprintf("dbx/live/%d/", time.Now().UnixNano())

	// --- KV basics -----------------------------------------------------
	putResult, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":   jsonString(prefix + "hello"),
		"value": jsonValue("world"),
	}))
	if err != nil {
		t.Fatalf("put failed: %v", err)
	}
	baseRevision := revisionOf(t, putResult)

	binaryEncoded := base64Encode([]byte{0x00, 0xff, 0x81})
	if _, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":   jsonString(prefix + "binary"),
		"value": json.RawMessage(`{"encoding":"base64","data":"` + binaryEncoded + `"}`),
	})); err != nil {
		t.Fatalf("binary put failed: %v", err)
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
		t.Fatalf("fresh key revisions should match: %#v", metadata)
	}

	binaryRow, err := state.get(paramsWith(map[string]json.RawMessage{"key": jsonString(prefix + "binary")}))
	if err != nil {
		t.Fatalf("binary get failed: %v", err)
	}
	binaryValue := binaryRow.(map[string]any)["value"].(map[string]any)
	if binaryValue["encoding"] != "base64" || binaryValue["data"] != binaryEncoded {
		t.Fatalf("binary round trip broken: %#v", binaryValue)
	}

	// CAS conflict on stale revision.
	if _, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":                 jsonString(prefix + "hello"),
		"value":               jsonValue("v2"),
		"expectedModRevision": json.RawMessage(`1`),
	})); err == nil || err.Error() != "ETCD_CAS_CONFLICT: key changed after it was loaded" {
		t.Fatalf("expected CAS conflict, got %v", err)
	}

	// CAS success with the fresh revision.
	if _, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":                 jsonString(prefix + "hello"),
		"value":               jsonValue("v3"),
		"expectedModRevision": json.RawMessage(metadata["modRevision"].(string)),
	})); err != nil {
		t.Fatalf("CAS put failed: %v", err)
	}

	// TTL put, lease metadata, and preserveLease.
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
	leasedMetadata := leased.(map[string]any)["metadata"].(map[string]any)
	if _, hasTTL := leasedMetadata["ttl"]; !hasTTL {
		t.Fatalf("leased key must expose ttl metadata: %#v", leasedMetadata)
	}
	if _, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":           jsonString(prefix + "leased"),
		"value":         jsonValue("renewed"),
		"preserveLease": json.RawMessage(`true`),
	})); err != nil {
		t.Fatalf("preserveLease put failed: %v", err)
	}
	if _, err := state.put(paramsWith(map[string]json.RawMessage{
		"key":           jsonString(prefix + "hello"),
		"value":         jsonValue("nope"),
		"preserveLease": json.RawMessage(`true`),
	})); err == nil || err.Error() != "Cannot preserve lease: key does not exist or has no lease" {
		t.Fatalf("expected preserveLease rejection, got %v", err)
	}

	// Rename, including conflict and missing-source paths.
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
	if _, err := state.rename(paramsWith(map[string]json.RawMessage{
		"key":    jsonString(prefix + "binary"),
		"newKey": jsonString(prefix + "renamed"),
	})); err == nil || err.Error() != "ETCD_CAS_CONFLICT: source changed or target already exists" {
		t.Fatalf("expected rename conflict, got %v", err)
	}

	// list_prefix with continuation.
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
	firstContinued := nextKeys[0].(map[string]any)["key"].(string)
	if firstContinued == list["keys"].([]any)[1].(map[string]any)["key"].(string) {
		t.Fatalf("continuation overlapped the first page")
	}

	// --- history -------------------------------------------------------
	// Explicit startRevision keeps the window above any revision compacted by
	// earlier verification runs (the flow itself compacts at the end).
	history, err := state.history(paramsWith(map[string]json.RawMessage{
		"key":           jsonString(prefix + "renamed"),
		"startRevision": json.RawMessage(longString(baseRevision)),
	}))
	if err != nil {
		t.Fatalf("history failed: %v", err)
	}
	historyRow := history.(map[string]any)
	events := historyRow["events"].([]any)
	// The renamed key only exists from the rename revision onward; the old
	// key's earlier revisions belong to the old key.
	if len(events) != 1 {
		t.Fatalf("expected exactly the rename event, got %#v", historyRow)
	}
	if historyRow["truncated"] != false {
		t.Fatalf("history should not be truncated for a short window: %#v", historyRow)
	}
	firstEvent := events[0].(map[string]any)
	if _, err := strconvParse(firstEvent["revision"].(string)); err != nil {
		t.Fatalf("revisions must be strings: %#v", firstEvent)
	}

	// --- watch ---------------------------------------------------------
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
	deadline := time.Now().Add(10 * time.Second)
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
		time.Sleep(100 * time.Millisecond)
	}
	if len(watchBatches) < 2 {
		t.Fatalf("watch did not deliver both events: %#v", watchBatches)
	}
	secondBatch := watchBatches[len(watchBatches)-1].(map[string]any)
	secondEvent := secondBatch["events"].([]map[string]any)[0]
	if secondEvent["previousValue"].(map[string]any)["data"] != "first" {
		t.Fatalf("prevKv missing on watch event: %#v", secondEvent)
	}
	stopped, err := state.watchStop(paramsWith(map[string]json.RawMessage{"watchId": json.RawMessage(`"` + watchID + `"`)}))
	if err != nil || stopped.(map[string]bool)["stopped"] != true {
		t.Fatalf("watch_stop failed: %#v %v", stopped, err)
	}
	if _, err := state.watchPoll(paramsWith(map[string]json.RawMessage{"watchId": json.RawMessage(`"` + watchID + `"`)})); err == nil || err.Error() != "ETCD_WATCH_NOT_FOUND: watch does not exist" {
		t.Fatalf("expected watch-not-found after stop, got %v", err)
	}

	// --- lease ---------------------------------------------------------
	granted, err := state.leaseGrant(paramsWith(map[string]json.RawMessage{"ttl": json.RawMessage(`120`)}))
	if err != nil {
		t.Fatalf("lease_grant failed: %v", err)
	}
	leaseID := granted.(map[string]any)["id"].(string)
	if _, err := state.leaseKeepAlive(paramsWith(map[string]json.RawMessage{"id": json.RawMessage(leaseID)})); err != nil {
		t.Fatalf("lease_keepalive_once failed: %v", err)
	}
	leaseListed, err := state.leaseList(paramsWith(map[string]json.RawMessage{}))
	if err != nil {
		t.Fatalf("lease_list failed: %v", err)
	}
	leaseListRow := leaseListed.(map[string]any)
	if leaseListRow["partial"] != false {
		t.Fatalf("lease list must be complete on etcd >= 3.4: %#v", leaseListRow)
	}
	foundLease := false
	for _, lease := range leaseListRow["leases"].([]map[string]any) {
		if lease["id"] == leaseID {
			foundLease = true
		}
	}
	if !foundLease {
		t.Fatalf("granted lease %s missing from list: %#v", leaseID, leaseListRow)
	}
	leaseDetail, err := state.leaseGet(paramsWith(map[string]json.RawMessage{
		"id":          json.RawMessage(leaseID),
		"includeKeys": json.RawMessage(`true`),
	}))
	if err != nil {
		t.Fatalf("lease_get failed: %v", err)
	}
	detail := leaseDetail.(map[string]any)
	if detail["grantedTtl"].(int64) != 120 && detail["grantedTtl"].(int64) < 100 {
		t.Fatalf("unexpected granted ttl: %#v", detail)
	}
	if _, err := state.leaseRevoke(paramsWith(map[string]json.RawMessage{"id": json.RawMessage(leaseID)})); err != nil {
		t.Fatalf("lease_revoke failed: %v", err)
	}

	// --- auth ----------------------------------------------------------
	userName := fmt.Sprintf("dbx_live_%d", time.Now().UnixNano()%100000)
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
	if len(permissions) != 1 || permissions[0]["access"] != "readwrite" || permissions[0]["resource"] != "prefix" {
		t.Fatalf("unexpected permission shape: %#v", permissions)
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
	if _, err := state.authUserGrantRevokeRole(paramsWith(map[string]json.RawMessage{
		"user": jsonString(userName),
		"role": jsonString("dbx_live_role"),
	}), false); err != nil {
		t.Fatalf("revoke role failed: %v", err)
	}
	if _, err := state.authRolePermission(paramsWith(map[string]json.RawMessage{
		"role":     jsonString("dbx_live_role"),
		"resource": jsonString("prefix"),
		"key":      jsonString(prefix),
	}), false); err != nil {
		t.Fatalf("role revoke permission failed: %v", err)
	}
	if _, err := state.authUserDelete(paramsWith(map[string]json.RawMessage{"user": jsonString(userName)})); err != nil {
		t.Fatalf("user delete failed: %v", err)
	}
	if _, err := state.authRoleDelete(paramsWith(map[string]json.RawMessage{"role": jsonString("dbx_live_role")})); err != nil {
		t.Fatalf("role delete failed: %v", err)
	}

	// --- status / maintenance ------------------------------------------
	status, err := state.status(paramsWith(map[string]json.RawMessage{}))
	if err != nil {
		t.Fatalf("kv_status failed: %v", err)
	}
	statusRow := status.(map[string]any)
	if statusRow["clusterId"] == nil || statusRow["leaderId"] == nil {
		t.Fatalf("status missing cluster identity: %#v", statusRow)
	}
	members := statusRow["members"].([]map[string]any)
	if len(members) == 0 || members[0]["reachable"] != true || members[0]["version"] == nil {
		t.Fatalf("unexpected member rows: %#v", members)
	}
	if keyCount, err := strconvParse(statusRow["keyCount"].(string)); err != nil || keyCount <= 0 {
		t.Fatalf("keyCount must be a positive numeric string: %#v", statusRow["keyCount"])
	}

	compactTarget := revisionOf(t, putResult)
	if compactTarget < baseRevision {
		compactTarget = baseRevision
	}
	if _, err := state.compact(paramsWith(map[string]json.RawMessage{"revision": json.RawMessage(statusRow["revision"].(string))})); err != nil {
		t.Fatalf("compact failed: %v", err)
	}
	if _, err := state.compact(paramsWith(map[string]json.RawMessage{"revision": json.RawMessage(`999999999999`)})); err == nil || !strings.Contains(err.Error(), "future revision") {
		t.Fatalf("expected raw future-revision error (Java parity), got %v", err)
	}
	defragged, err := state.defrag(paramsWith(map[string]json.RawMessage{
		"endpoints": json.RawMessage(`["` + endpoints + `"]`),
	}))
	if err != nil {
		t.Fatalf("defrag failed: %v", err)
	}
	defragRow := defragged.(map[string]any)["members"].([]map[string]any)[0]
	if defragRow["status"] != "succeeded" {
		t.Fatalf("defrag should succeed on a live member: %#v", defragRow)
	}

	// --- delete + cleanup ----------------------------------------------
	for _, key := range []string{prefix + "binary", prefix + "leased", prefix + "renamed", prefix + "watched"} {
		if _, err := state.delete(paramsWith(map[string]json.RawMessage{"key": jsonString(key)})); err != nil {
			t.Fatalf("delete %s failed: %v", key, err)
		}
	}
	if _, err := state.delete(paramsWith(map[string]json.RawMessage{"key": jsonString(prefix + "renamed")})); err != nil {
		t.Fatalf("delete missing key failed: %v", err)
	}
}

// TestLiveEtcdProtocolFlow drives the multi-session runtime exactly like the
// Rust host does: NDJSON lines with agentSessionId routing.
func TestLiveEtcdProtocolFlow(t *testing.T) {
	if os.Getenv("DBX_ETCD_LIVE") != "1" {
		t.Skip("set DBX_ETCD_LIVE=1 to run the live etcd agent test")
	}
	endpoints := envOrDefault("DBX_ETCD_ENDPOINTS", "http://127.0.0.1:10700")
	user := envOrDefault("DBX_ETCD_USER", "root")
	password := envOrDefault("DBX_ETCD_PASSWORD", "123456")

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

	putLine := fmt.Sprintf(`{"id":3,"method":"kv_put","params":{"agentSessionId":"s1","key":"dbx:proto","value":{"encoding":"utf8","data":"flow"}}}`)
	put, _ := server.handleLine(putLine)
	if put.Error != nil {
		t.Fatalf("kv_put failed: %#v", put)
	}

	unknown, _ := server.handleLine(`{"id":4,"method":"kv_describe","params":{"agentSessionId":"s1"}}`)
	if unknown.Error == nil || !strings.Contains(unknown.Error.Message, "unknown method") {
		t.Fatalf("expected unknown-method error, got %#v", unknown)
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

func revisionOf(t *testing.T, result any) int64 {
	t.Helper()
	row, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("expected map result, got %#v", result)
	}
	revision, err := strconvParse(row["revision"].(string))
	if err != nil {
		t.Fatalf("revision not numeric: %#v", row["revision"])
	}
	return revision
}

func strconvParse(value string) (int64, error) {
	var parsed int64
	_, err := fmt.Sscan(value, &parsed)
	return parsed, err
}

func containsAny(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
