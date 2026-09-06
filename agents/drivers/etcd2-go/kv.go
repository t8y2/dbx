package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const defaultListLimit = 100

// v2Node is one node of the etcd v2 keys API tree.
type v2Node struct {
	Key           string   `json:"key"`
	Value         string   `json:"value"`
	Dir           bool     `json:"dir"`
	Expiration    *string  `json:"expiration"`
	TTL           *int64   `json:"ttl"`
	CreatedIndex  int64    `json:"createdIndex"`
	ModifiedIndex int64    `json:"modifiedIndex"`
	Nodes         []v2Node `json:"nodes"`
}

type v2KeysResponse struct {
	Action   string  `json:"action"`
	Node     *v2Node `json:"node"`
	PrevNode *v2Node `json:"prevNode"`
}

// v2KeyPath normalizes a protocol key into a v2 keys API path. v2 keys are
// slash paths; an empty prefix maps to the root directory.
func v2KeyPath(key string) string {
	if key == "" {
		return "/v2/keys/"
	}
	if !strings.HasPrefix(key, "/") {
		key = "/" + key
	}
	return "/v2/keys" + key
}

func (s *etcd2Session) listPrefix(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	prefix := stringOrDefault(params, "prefix", "")
	limit := intOrDefault(params, "limit", defaultListLimit)
	if limit < 1 {
		limit = 1
	}
	includeValues := boolOrDefault(params, "includeValues", false)
	continuation := stringOrNull(params, "continuation")

	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	// v2 has no revisioned reads; the revision parameter is accepted and ignored.
	query := url.Values{}
	query.Set("recursive", "true")
	query.Set("sorted", "true")
	body, _, err := client.do(ctx, http.MethodGet, v2KeyPath(prefix)+"?"+query.Encode(), "", nil)
	if err != nil {
		if isNotFound(err) {
			return map[string]any{"keys": []any{}, "continuation": nil, "revision": nil}, nil
		}
		return nil, err
	}
	var parsed v2KeysResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}

	startAfter := ""
	if continuation != nil && *continuation != "" {
		startAfter = *continuation
	}
	rows := []map[string]any{}
	flattenNodes(parsed.Node, includeValues, func(row map[string]any) {
		key := row["key"].(string)
		if startAfter != "" && key <= startAfter {
			return
		}
		if len(rows) < limit {
			rows = append(rows, row)
		}
	})

	result := map[string]any{"keys": toAnySlice(rows)}
	if len(rows) == limit {
		result["continuation"] = rows[len(rows)-1]["key"]
	} else {
		result["continuation"] = nil
	}
	// etcd v2 exposes the current index on the listing's node headers; the
	// modifiedIndex of the returned root is the closest analog of a revision.
	var revision any
	if parsed.Node != nil {
		revision = longString(parsed.Node.ModifiedIndex)
	}
	result["revision"] = revision
	return result, nil
}

func flattenNodes(node *v2Node, includeValues bool, emit func(map[string]any)) {
	if node == nil {
		return
	}
	if !node.Dir {
		row := nodeMetadata(node)
		row["key"] = node.Key
		if includeValues {
			row["value"] = valueObject([]byte(node.Value))
		}
		emit(row)
		return
	}
	children := append([]v2Node(nil), node.Nodes...)
	sort.SliceStable(children, func(i, j int) bool { return children[i].Key < children[j].Key })
	for index := range children {
		flattenNodes(&children[index], includeValues, emit)
	}
}

func toAnySlice(rows []map[string]any) []any {
	result := make([]any, len(rows))
	for index, row := range rows {
		result[index] = row
	}
	return result
}

func (s *etcd2Session) get(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	key, err := keyBytesParam(params)
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	body, _, err := client.do(ctx, http.MethodGet, v2KeyPath(key), "", nil)
	if err != nil {
		if isNotFound(err) {
			return map[string]any{"found": false, "key": nil, "value": nil, "metadata": nil}, nil
		}
		return nil, err
	}
	var parsed v2KeysResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	if parsed.Node == nil || parsed.Node.Dir {
		return map[string]any{"found": false, "key": nil, "value": nil, "metadata": nil}, nil
	}
	node := parsed.Node
	result := map[string]any{
		"found":    true,
		"key":      node.Key,
		"keyBytes": bytesObject([]byte(node.Key)),
	}
	if !boolOrDefault(params, "metadataOnly", false) {
		result["value"] = valueObject([]byte(node.Value))
	} else {
		result["value"] = nil
	}
	result["metadata"] = nodeMetadata(node)
	return result, nil
}

func (s *etcd2Session) put(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	key, err := keyBytesParam(params)
	if err != nil {
		return nil, err
	}
	value, err := parseValueObject(rawObject(params, "value"))
	if err != nil {
		return nil, err
	}
	expectedModRevision := longOrNull(params, "expectedModRevision")
	expectedCreateRevision := longOrNull(params, "expectedCreateRevision")
	ttlValue := longOrNull(params, "ttl")
	preserveLease := boolOrDefault(params, "preserveLease", false)

	leaseValue := longOrNull(params, "lease")
	hasLease := leaseValue != nil
	hasTtl := ttlValue != nil
	if (hasLease && hasTtl) || (preserveLease && (hasLease || hasTtl)) {
		return nil, errors.New("lease, ttl, and preserveLease cannot be specified together")
	}
	if hasLease {
		return nil, errors.New("ETCD_V2_LEASE_UNSUPPORTED: the etcd v2 API has no lease objects; use ttl instead")
	}
	if preserveLease {
		return nil, errors.New("ETCD_V2_LEASE_UNSUPPORTED: the etcd v2 API has no lease objects; use ttl instead")
	}
	if expectedCreateRevision != nil && *expectedCreateRevision != 0 {
		return nil, errors.New("ETCD_V2_CAS_UNSUPPORTED: the etcd v2 API cannot compare createdIndex; use expectedModRevision")
	}
	if hasTtl && *ttlValue <= 0 {
		return nil, errors.New("ttl must be a positive integer")
	}

	form := url.Values{}
	form.Set("value", value)
	if hasTtl {
		form.Set("ttl", strconv.FormatInt(*ttlValue, 10))
	}
	if expectedModRevision != nil {
		form.Set("prevIndex", strconv.FormatInt(*expectedModRevision, 10))
	}
	if expectedCreateRevision != nil && *expectedCreateRevision == 0 {
		form.Set("prevExist", "false")
	}

	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	body, _, err := client.do(ctx, http.MethodPut, v2KeyPath(key), form.Encode(), nil)
	if err != nil {
		if isCompareFailed(err) {
			return nil, errors.New("ETCD_CAS_CONFLICT: key changed after it was loaded")
		}
		return nil, err
	}
	var parsed v2KeysResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	var revision int64
	if parsed.Node != nil {
		revision = parsed.Node.ModifiedIndex
	}
	return map[string]any{"revision": longString(revision)}, nil
}

func (s *etcd2Session) delete(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	key, err := keyBytesParam(params)
	if err != nil {
		return nil, err
	}
	expectedModRevision := longOrNull(params, "expectedModRevision")
	path := v2KeyPath(key)
	if expectedModRevision != nil {
		query := url.Values{}
		query.Set("prevIndex", strconv.FormatInt(*expectedModRevision, 10))
		path += "?" + query.Encode()
	}
	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	body, _, err := client.do(ctx, http.MethodDelete, path, "", nil)
	if err != nil {
		if isCompareFailed(err) {
			return nil, errors.New("ETCD_CAS_CONFLICT: key changed after it was loaded")
		}
		return nil, err
	}
	var parsed v2KeysResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	var revision int64
	if parsed.Node != nil {
		revision = parsed.Node.ModifiedIndex
	}
	return map[string]any{"deleted": int64(1), "revision": longString(revision)}, nil
}

// rename is a non-atomic check-then-set: the v2 API has no transactions, so a
// concurrent writer between the target check and the delete can be lost. The
// protocol exposes this honestly instead of pretending atomicity.
func (s *etcd2Session) rename(params map[string]json.RawMessage) (any, error) {
	client, err := s.activeClient()
	if err != nil {
		return nil, err
	}
	sourceKey, err := keyBytesParam(params)
	if err != nil {
		return nil, err
	}
	newKey := stringOrNull(params, "newKey")
	if newKey == nil || *newKey == "" {
		return nil, errors.New("ETCD_NEWKEY_REQUIRED")
	}
	targetKey := *newKey
	if sourceKey == targetKey {
		return map[string]any{"renamed": true, "revision": nil}, nil
	}

	ctx, cancel := s.beginOperation()
	defer s.endOperation(cancel)
	body, _, err := client.do(ctx, http.MethodGet, v2KeyPath(sourceKey), "", nil)
	if err != nil {
		if isNotFound(err) {
			return nil, errors.New("ETCD_NOT_FOUND: source key does not exist")
		}
		return nil, err
	}
	var source v2KeysResponse
	if err := json.Unmarshal(body, &source); err != nil {
		return nil, err
	}
	if source.Node == nil || source.Node.Dir {
		return nil, errors.New("ETCD_NOT_FOUND: source key does not exist")
	}
	if _, _, err := client.do(ctx, http.MethodGet, v2KeyPath(targetKey), "", nil); err == nil {
		return nil, errors.New("ETCD_CAS_CONFLICT: source changed or target already exists")
	} else if !isNotFound(err) {
		return nil, err
	}

	expected := longOrNull(params, "expectedModRevision")
	expectedRevision := source.Node.ModifiedIndex
	if expected != nil {
		expectedRevision = *expected
	}
	form := url.Values{}
	form.Set("value", source.Node.Value)
	if source.Node.TTL != nil {
		form.Set("ttl", strconv.FormatInt(*source.Node.TTL, 10))
	}
	form.Set("prevExist", "false")
	if _, _, err := client.do(ctx, http.MethodPut, v2KeyPath(targetKey), form.Encode(), nil); err != nil {
		if isCompareFailed(err) {
			return nil, errors.New("ETCD_CAS_CONFLICT: source changed or target already exists")
		}
		return nil, err
	}
	deleteQuery := url.Values{}
	deleteQuery.Set("prevIndex", strconv.FormatInt(expectedRevision, 10))
	if _, _, err := client.do(ctx, http.MethodDelete, v2KeyPath(sourceKey)+"?"+deleteQuery.Encode(), "", nil); err != nil {
		if isCompareFailed(err) {
			return nil, errors.New("ETCD_CAS_CONFLICT: source changed or target already exists")
		}
		return nil, err
	}
	return map[string]any{"renamed": true, "revision": nil}, nil
}

func nodeMetadata(node *v2Node) map[string]any {
	metadata := map[string]any{
		"createRevision": longString(node.CreatedIndex),
		"modRevision":    longString(node.ModifiedIndex),
		"version":        longString(int64(1)),
		"lease":          longString(0),
		"valueSize":      len(node.Value),
	}
	if node.TTL != nil {
		metadata["ttl"] = *node.TTL
	}
	return metadata
}

func longString(value int64) string {
	return strconv.FormatInt(value, 10)
}

func unsignedLongString(value int64) string {
	return strconv.FormatUint(uint64(value), 10)
}

// prefixEnd mirrors the v3 agent's byte-increment range end; for v2 rows it
// only feeds UI metadata, where the explicit resource field carries the truth.
func prefixEnd(prefix string) string {
	if prefix == "" {
		return "\x00"
	}
	end := []byte(prefix)
	for i := len(end) - 1; i >= 0; i-- {
		if end[i] < 0xff {
			end[i]++
			return string(end[:i+1])
		}
	}
	return "\x00"
}

func keyBytesParam(params map[string]json.RawMessage) (string, error) {
	if encoded := rawObject(params, "keyBytes"); encoded != nil {
		value, err := parseValueObject(encoded)
		if err != nil {
			return "", err
		}
		return value, nil
	}
	if raw, ok := params["key"]; ok && raw != nil && string(raw) != "null" {
		var key string
		if err := json.Unmarshal(raw, &key); err != nil {
			return "", err
		}
		return key, nil
	}
	return "", errors.New("Key is required")
}

func rawObject(params map[string]json.RawMessage, key string) map[string]json.RawMessage {
	raw := params[key]
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil
	}
	return object
}

func bytesObject(bytes []byte) map[string]any {
	return map[string]any{
		"encoding": "base64",
		"data":     base64.StdEncoding.EncodeToString(bytes),
	}
}

func valueObject(value []byte) map[string]any {
	if utf8.Valid(value) {
		return map[string]any{"encoding": "utf8", "data": string(value)}
	}
	return bytesObject(value)
}

func displayBytes(bytes []byte) string {
	if utf8.Valid(bytes) {
		return string(bytes)
	}
	return base64.StdEncoding.EncodeToString(bytes)
}

func parseValueObject(value map[string]json.RawMessage) (string, error) {
	if value == nil {
		value = map[string]json.RawMessage{}
	}
	encoding := stringOrDefault(value, "encoding", "utf8")
	data := stringOrDefault(value, "data", "")
	if encoding == "base64" {
		decoded, err := base64.StdEncoding.DecodeString(data)
		if err != nil {
			return "", err
		}
		return string(decoded), nil
	}
	if encoding != "utf8" {
		return "", fmt.Errorf("Unsupported value encoding: %s", encoding)
	}
	return data, nil
}

func stringOrNull(params map[string]json.RawMessage, key string) *string {
	raw := params[key]
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return &value
}

func stringOrDefault(params map[string]json.RawMessage, key string, fallback string) string {
	value := stringOrNull(params, key)
	if value == nil {
		return fallback
	}
	return *value
}

func intOrDefault(params map[string]json.RawMessage, key string, fallback int) int {
	raw := params[key]
	if len(raw) == 0 || string(raw) == "null" {
		return fallback
	}
	var value int
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback
	}
	return value
}

func boolOrDefault(params map[string]json.RawMessage, key string, fallback bool) bool {
	raw := params[key]
	if len(raw) == 0 || string(raw) == "null" {
		return fallback
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return fallback
	}
	return value
}

func longOrNull(params map[string]json.RawMessage, key string) *int64 {
	raw := params[key]
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	return &value
}

func requiredString(params map[string]json.RawMessage, field string) (string, error) {
	value := stringOrNull(params, field)
	if value == nil || *value == "" {
		return "", fmt.Errorf("ETCD_%s_REQUIRED", strings.ToUpper(field))
	}
	return *value, nil
}
